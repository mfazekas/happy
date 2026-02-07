#!/usr/bin/env tsx
/**
 * Mode-switch harness that replicates the stdin lifecycle from
 * the real happy CLI: local → remote → local.
 *
 * Now uses PTY proxy for local mode spawns (matching the production fix),
 * which gives each child its own pseudo-terminal and avoids stdin corruption.
 *
 * CLI args:
 *   --program <cmd>      Child program to spawn (default: cat)
 *   --delay <seconds>    How long each phase runs (default: 5)
 *   --no-ink             Skip Ink, use manual stdin ops instead
 *   --no-pty             Use old stdio:inherit approach (to reproduce the bug)
 */

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { render } from 'ink';
import React from 'react';
import { Text } from 'ink';

function createSeparateTtyStream(): { stream: ReadStream; fd: number } {
    const fd = openSync('/dev/tty', 'r');
    const stream = new ReadStream(fd);
    return { stream, fd };
}

function destroyTtyStream(stream: ReadStream, fd: number) {
    stream.removeAllListeners();
    stream.destroy();
    try { closeSync(fd); } catch { /* already closed by destroy */ }
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let program = 'cat';
let delay = 5;
let noInk = false;
let noPty = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--program' && args[i + 1]) {
        program = args[i + 1];
        i++;
    } else if (args[i] === '--delay' && args[i + 1]) {
        delay = Number(args[i + 1]);
        i++;
    } else if (args[i] === '--no-ink') {
        noInk = true;
    } else if (args[i] === '--no-pty') {
        noPty = true;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
    process.stderr.write(`[harness] ${msg}\n`);
}

function sleep(seconds: number): Promise<void> {
    return new Promise(r => setTimeout(r, seconds * 1000));
}

/**
 * Phase 1 & 3: Local mode — spawn a child process.
 *
 * With --no-pty: uses stdio:'inherit' (old broken approach).
 * Without --no-pty: uses node-pty PTY proxy (new fixed approach).
 */
async function spawnLocal(label: string): Promise<void> {
    log(`${label}: noPty=${noPty}`);

    if (noPty) {
        return spawnLocalInherit(label);
    } else {
        return spawnLocalPty(label);
    }
}

/** Old approach: stdio:'inherit' — reproduces the bug */
function spawnLocalInherit(label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        log(`${label}: process.stdin.pause()`);
        process.stdin.pause();

        const parts = program.split(' ');
        const cmd = parts[0];
        const cmdArgs = parts.slice(1);

        log(`${label}: spawning "${program}" with stdio:inherit`);
        const child = spawn(cmd, cmdArgs, {
            stdio: ['inherit', 'inherit', 'inherit'],
        });

        child.on('error', (err) => {
            log(`${label}: child error: ${err.message}`);
            reject(err);
        });

        child.on('exit', (code, signal) => {
            log(`${label}: child exited code=${code} signal=${signal}`);
            resolve();
        });

        setTimeout(() => {
            if (!child.killed) {
                log(`${label}: killing child after ${delay}s`);
                child.kill('SIGTERM');
            }
        }, delay * 1000);
    }).finally(() => {
        log(`${label}: process.stdin.resume() (finally)`);
        process.stdin.resume();
    });
}

/** New approach: PTY proxy — isolates child stdin from parent */
async function spawnLocalPty(label: string): Promise<void> {
    const nodePty = await import('node-pty');
    const pty = nodePty.default || nodePty;

    return new Promise<void>((resolve, reject) => {
        const parts = program.split(' ');
        const cmd = parts[0];
        const cmdArgs = parts.slice(1);

        log(`${label}: spawning "${program}" via PTY proxy`);
        const ptyProcess = pty.spawn(cmd, cmdArgs, {
            name: 'xterm-256color',
            cols: process.stdout.columns || 80,
            rows: process.stdout.rows || 24,
            cwd: process.cwd(),
            env: { ...process.env } as Record<string, string>,
        });

        // Proxy PTY output → parent stdout
        ptyProcess.onData((data: string) => {
            process.stdout.write(data);
        });

        // Proxy parent stdin → PTY
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();

        const stdinHandler = (data: Buffer) => {
            ptyProcess.write(data.toString());
        };
        process.stdin.on('data', stdinHandler);

        ptyProcess.onExit(({ exitCode, signal: sig }) => {
            process.stdin.removeListener('data', stdinHandler);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
            log(`${label}: PTY child exited code=${exitCode} signal=${sig}`);
            resolve();
        });

        setTimeout(() => {
            log(`${label}: killing PTY child after ${delay}s`);
            ptyProcess.kill();
        }, delay * 1000);
    });
}

// ── Ink component that mimics RemoteModeDisplay ──────────────────────────────

const RemoteSim: React.FC = () => {
    return React.createElement(Text, { color: 'yellow' },
        '[harness] Remote mode active (no input handlers).'
    );
};

/**
 * Phase 2: Remote mode with Ink on a separate /dev/tty fd.
 */
async function runRemoteInk(): Promise<void> {
    log('remote(ink): rendering Ink on separate /dev/tty fd');

    const { stream: inkStdin, fd: inkStdinFd } = createSeparateTtyStream();
    process.stdin.pause();

    const inkInstance = render(
        React.createElement(RemoteSim),
        {
            stdin: inkStdin,
            exitOnCtrlC: false,
            patchConsole: false
        }
    );

    await sleep(delay);

    log('remote(ink): cleanup — unmount');
    inkInstance.unmount();
    destroyTtyStream(inkStdin, inkStdinFd);
}

/**
 * Phase 2 (variant): Remote mode without Ink — manual stdin operations on a
 * separate ReadStream.
 */
async function runRemoteManual(): Promise<void> {
    log('remote(manual): setting up manual stdin handlers on separate stream');

    const { stream: manualStdin, fd } = createSeparateTtyStream();
    process.stdin.pause();

    await new Promise<void>((resolve) => {
        manualStdin.setEncoding('utf8');
        manualStdin.setRawMode(true);

        const handler = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    log('remote(manual): Enter pressed, switching');
                    resolve();
                    return;
                }
            }
        };

        manualStdin.on('data', handler);
        manualStdin.resume();

        setTimeout(() => {
            log('remote(manual): auto-switching after delay');
            resolve();
        }, delay * 1000);
    });

    destroyTtyStream(manualStdin, fd);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    log(`program="${program}" delay=${delay}s noInk=${noInk} noPty=${noPty}`);
    log('=== PHASE 1: Local mode (first spawn) ===');
    await spawnLocal('phase1');

    log('=== PHASE 2: Remote mode ===');

    if (noInk) {
        await runRemoteManual();
    } else {
        await runRemoteInk();
    }

    // Small delay to let async cleanup complete
    await sleep(0.2);

    log('=== PHASE 3: Local mode (second spawn — after remote cleanup) ===');
    await spawnLocal('phase3');

    log('=== DONE ===');
    process.exit(0);
}

main().catch((err) => {
    log(`Fatal error: ${err.message}`);
    process.exit(1);
});
