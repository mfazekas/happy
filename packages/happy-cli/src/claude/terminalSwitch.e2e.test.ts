/**
 * E2E tests for stdin after remote→local mode switch.
 *
 * Tests two approaches:
 * 1. PTY proxy (new fix): Each local-mode child gets its own PTY, isolating
 *    it from the parent's stdin state. This should always work.
 * 2. stdio:inherit (old, broken): Reproduces the original bug where Node.js
 *    children stop receiving stdin after Ink touches process.stdin.
 *
 * Run explicitly (not included in normal vitest glob):
 *   npx vitest run src/claude/terminalSwitch.e2e.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';

const PKG_ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS_DIR = join(PKG_ROOT, 'scripts');
const TSX_BIN = join(PKG_ROOT, 'node_modules', '.bin', 'tsx');
const HARNESS_PATH = join(SCRIPTS_DIR, 'mode-switch-harness.tsx');
const LOGGER_PATH = join(SCRIPTS_DIR, 'test-stdin-logger.mjs');
const TMP_DIR = join(PKG_ROOT, '.tmp-test');

// ── OutputTracker: buffers PTY output, provides waitFor(pattern) ─────────────

class OutputTracker {
    private buffer = '';
    private waiters: Array<{
        pattern: RegExp;
        resolve: () => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
    }> = [];

    append(data: string) {
        this.buffer += data;
        // Check waiting patterns
        for (let i = this.waiters.length - 1; i >= 0; i--) {
            if (this.waiters[i].pattern.test(this.buffer)) {
                clearTimeout(this.waiters[i].timer);
                this.waiters[i].resolve();
                this.waiters.splice(i, 1);
            }
        }
    }

    getBuffer(): string {
        return this.buffer;
    }

    waitFor(pattern: RegExp, timeoutMs = 15000): Promise<void> {
        if (pattern.test(this.buffer)) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.findIndex(w => w.timer === timer);
                if (idx !== -1) this.waiters.splice(idx, 1);
                reject(new Error(
                    `Timed out waiting for pattern ${pattern} after ${timeoutMs}ms.\n` +
                    `Buffer contents:\n${this.buffer}`
                ));
            }, timeoutMs);
            this.waiters.push({ pattern, resolve, reject, timer });
        });
    }

    destroy() {
        for (const w of this.waiters) {
            clearTimeout(w.timer);
            w.reject(new Error('OutputTracker destroyed'));
        }
        this.waiters = [];
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function logFilePath(testName: string): string {
    return join(TMP_DIR, `${testName}-${Date.now()}.jsonl`);
}

function readLogEntries(path: string): Array<Record<string, unknown>> {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function safeUnlink(path: string) {
    try { unlinkSync(path); } catch { /* ignore */ }
}

/**
 * Spawn the harness in a PTY via node-pty, send test chars during phase 3,
 * and return the output tracker + cleanup function.
 */
async function spawnHarness(opts: {
    program: string;
    delay: number;
    noInk?: boolean;
    noPty?: boolean;
    sendCharsInPhase3?: string;
}): Promise<{ tracker: OutputTracker; exitCode: number }> {
    // Dynamic import so the test file can be parsed even if node-pty isn't installed yet
    const nodePty = await import('node-pty');
    const pty = nodePty.default || nodePty;

    const tracker = new OutputTracker();

    const harnessArgs = [
        HARNESS_PATH,
        '--program', opts.program,
        '--delay', String(opts.delay),
    ];
    if (opts.noInk) {
        harnessArgs.push('--no-ink');
    }
    if (opts.noPty) {
        harnessArgs.push('--no-pty');
    }

    const ptyProcess = pty.spawn(TSX_BIN, harnessArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: PKG_ROOT,
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    ptyProcess.onData((data: string) => {
        tracker.append(data);
    });

    // Wait for phase 3 to start, then send test characters
    const charsToSend = opts.sendCharsInPhase3 ?? 'ABC';

    try {
        await tracker.waitFor(/PHASE 3/, 30000);
        // Small delay to let the child process start and register stdin
        await new Promise(r => setTimeout(r, 500));
        for (const ch of charsToSend) {
            ptyProcess.write(ch);
            await new Promise(r => setTimeout(r, 50));
        }
        // Send newline so the PTY line discipline delivers buffered chars to the child.
        // Without this, chars are echoed by the PTY but never reach the child's read().
        ptyProcess.write('\r');
        await new Promise(r => setTimeout(r, 200));
    } catch {
        // If phase 3 never starts, the test will fail on assertions anyway
    }

    // Wait for harness to finish
    const exitCode = await new Promise<number>((resolve) => {
        const timeout = setTimeout(() => {
            ptyProcess.kill();
            resolve(-1);
        }, 60000);

        ptyProcess.onExit(({ exitCode: code }) => {
            clearTimeout(timeout);
            resolve(code);
        });
    });

    tracker.destroy();
    return { tracker, exitCode };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
});

describe('stdin after local→remote→local mode switch', () => {

    it('baseline: stdin-logger receives chars when spawned directly in PTY', async () => {
        const logFile = logFilePath('baseline');
        safeUnlink(logFile);

        const nodePty = await import('node-pty');
        const pty = nodePty.default || nodePty;
        const tracker = new OutputTracker();

        const ptyProcess = pty.spawn('node', [LOGGER_PATH, logFile], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: PKG_ROOT,
            env: { ...process.env },
        });

        ptyProcess.onData((data: string) => tracker.append(data));

        // Give the process time to start
        await new Promise(r => setTimeout(r, 1000));

        // Send test chars
        ptyProcess.write('X');
        await new Promise(r => setTimeout(r, 150));
        ptyProcess.write('Y');
        await new Promise(r => setTimeout(r, 150));
        ptyProcess.write('Z');

        // Wait for echo back from the logger (it writes chars to stdout)
        await tracker.waitFor(/Z/, 5000);

        // Give file stream time to flush before killing
        await new Promise(r => setTimeout(r, 500));

        // Send EOF (Ctrl-D) so the logger's stdin 'end' fires and flushes cleanly
        ptyProcess.write('\x04');
        await new Promise(r => setTimeout(r, 500));

        // Kill and wait for exit
        ptyProcess.kill();
        await new Promise<void>(resolve => {
            ptyProcess.onExit(() => resolve());
        });

        // Check log file
        const entries = readLogEntries(logFile);
        const chars = entries.filter(e => e.type === 'char').map(e => e.char);
        expect(chars).toContain('X');
        expect(chars).toContain('Y');
        expect(chars).toContain('Z');

        safeUnlink(logFile);
        tracker.destroy();
    }, 20000);

    it('PTY proxy: stdin-logger receives chars after local→remote→local cycle (Ink)', async () => {
        const logFile = logFilePath('pty-ink-cycle');
        safeUnlink(logFile);

        const loggerCmd = `node ${LOGGER_PATH} ${logFile}`;

        const { tracker } = await spawnHarness({
            program: loggerCmd,
            delay: 2,
            noPty: false,
            sendCharsInPhase3: 'DEF',
        });

        const buf = tracker.getBuffer();

        // With PTY proxy, the child gets its own PTY — stdin should work
        expect(buf).toContain('D');
        expect(buf).toContain('E');
        expect(buf).toContain('F');

        // Also verify the log file (sync writes, so always flushed)
        const entries = readLogEntries(logFile);
        const chars = entries.filter(e => e.type === 'char').map(e => e.char);
        expect(chars).toContain('D');
        expect(chars).toContain('E');
        expect(chars).toContain('F');

        safeUnlink(logFile);
    }, 60000);

    it('PTY proxy: stdin-logger receives chars after local→remote→local cycle (no Ink)', async () => {
        const logFile = logFilePath('pty-manual-cycle');
        safeUnlink(logFile);

        const loggerCmd = `node ${LOGGER_PATH} ${logFile}`;

        const { tracker } = await spawnHarness({
            program: loggerCmd,
            delay: 2,
            noInk: true,
            noPty: false,
            sendCharsInPhase3: 'GHI',
        });

        const buf = tracker.getBuffer();

        expect(buf).toContain('G');
        expect(buf).toContain('H');
        expect(buf).toContain('I');

        const entries = readLogEntries(logFile);
        const chars = entries.filter(e => e.type === 'char').map(e => e.char);
        expect(chars).toContain('G');
        expect(chars).toContain('H');
        expect(chars).toContain('I');

        safeUnlink(logFile);
    }, 60000);

    it('cat receives stdin after local→remote→local cycle (PTY proxy)', async () => {
        const { tracker } = await spawnHarness({
            program: 'cat',
            delay: 2,
            noPty: false,
            sendCharsInPhase3: 'ABC',
        });

        const buf = tracker.getBuffer();
        expect(buf).toContain('A');
        expect(buf).toContain('B');
        expect(buf).toContain('C');
    }, 60000);
});
