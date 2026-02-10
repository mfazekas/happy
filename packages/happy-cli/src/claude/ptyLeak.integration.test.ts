/**
 * Integration tests for node-pty PTY fd leak on macOS.
 *
 * These tests spawn REAL node-pty processes (no mocks) and verify that
 * PTY file descriptors are properly cleaned up after the child exits.
 *
 * The bug (microsoft/node-pty#882): v1.1.0 leaked 1 PTY master fd per
 * pty.spawn() due to an off-by-one in the low_fds cleanup loop on macOS.
 * Fixed in 1.2.0-beta.9+.
 *
 * Run with: npx vitest run src/claude/ptyLeak.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/** Count open PTY-related fds owned by this process via lsof. */
function countPtyFds(): number {
    try {
        const out = execFileSync('bash', ['-c', `lsof -p ${process.pid} 2>/dev/null | grep -c '/dev/ptmx\\|/dev/ttys'`], {
            encoding: 'utf8'
        });
        return parseInt(out.trim(), 10) || 0;
    } catch {
        // grep returns exit 1 when no matches — that means 0
        return 0;
    }
}

/** Count PTY device files in /dev to see system-wide allocation. */
function countSystemPtys(): number {
    try {
        const out = execFileSync('bash', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l'], {
            encoding: 'utf8'
        });
        return parseInt(out.trim(), 10) || 0;
    } catch {
        return 0;
    }
}

describe('node-pty PTY fd leak (macOS)', () => {

    it('should not leak PTY fds after spawning and waiting for exit', async () => {
        const pty = await import('node-pty');
        const nodePty = pty.default || pty;

        const baselineFds = countPtyFds();
        const baselinePtys = countSystemPtys();
        const iterations = 20;

        for (let i = 0; i < iterations; i++) {
            await new Promise<void>((resolve) => {
                const proc = nodePty.spawn('echo', ['hello'], {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 24,
                });

                proc.onExit(() => {
                    resolve();
                });
            });
        }

        // Small delay for OS to reclaim fds
        await new Promise((r) => setTimeout(r, 500));

        const afterFds = countPtyFds();
        const afterPtys = countSystemPtys();

        const fdLeak = afterFds - baselineFds;
        const ptyLeak = afterPtys - baselinePtys;

        // With the v1.1.0 bug, fdLeak would be ~20 (1 per spawn).
        // With the fix, it should be 0 (or at most 1-2 from timing).
        expect(fdLeak).toBeLessThanOrEqual(2);
        expect(ptyLeak).toBeLessThanOrEqual(2);
    }, 30_000);

    it('should not leak PTY fds when process is killed before exit', async () => {
        const pty = await import('node-pty');
        const nodePty = pty.default || pty;

        const baselineFds = countPtyFds();
        const iterations = 15;

        for (let i = 0; i < iterations; i++) {
            await new Promise<void>((resolve) => {
                const proc = nodePty.spawn('sleep', ['60'], {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 24,
                });

                proc.onExit(() => {
                    resolve();
                });

                // Kill after a brief moment
                setTimeout(() => {
                    try { proc.kill(); } catch { /* already dead */ }
                }, 50);
            });
        }

        await new Promise((r) => setTimeout(r, 500));

        const afterFds = countPtyFds();
        const fdLeak = afterFds - baselineFds;

        expect(fdLeak).toBeLessThanOrEqual(2);
    }, 30_000);

    it('should not leak PTY fds when process group is killed via SIGTERM', async () => {
        const pty = await import('node-pty');
        const nodePty = pty.default || pty;

        const baselineFds = countPtyFds();
        const iterations = 15;

        for (let i = 0; i < iterations; i++) {
            await new Promise<void>((resolve) => {
                const proc = nodePty.spawn('sleep', ['60'], {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 24,
                });

                proc.onExit(() => {
                    resolve();
                });

                // Kill the process group (like our abort handler does)
                setTimeout(() => {
                    try {
                        process.kill(-proc.pid, 'SIGTERM');
                    } catch {
                        try { proc.kill(); } catch { /* already dead */ }
                    }
                }, 50);
            });
        }

        await new Promise((r) => setTimeout(r, 500));

        const afterFds = countPtyFds();
        const fdLeak = afterFds - baselineFds;

        expect(fdLeak).toBeLessThanOrEqual(2);
    }, 30_000);

    it('should handle rapid spawn-kill cycles without accumulating fds', async () => {
        const pty = await import('node-pty');
        const nodePty = pty.default || pty;

        const baselineFds = countPtyFds();
        const iterations = 50;

        for (let i = 0; i < iterations; i++) {
            await new Promise<void>((resolve) => {
                const proc = nodePty.spawn('true', [], {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 24,
                });

                proc.onExit(() => {
                    resolve();
                });
            });
        }

        await new Promise((r) => setTimeout(r, 500));

        const afterFds = countPtyFds();
        const fdLeak = afterFds - baselineFds;

        // 50 iterations with the old bug = 50 leaked fds.
        // With the fix, should be 0.
        expect(fdLeak).toBeLessThanOrEqual(2);
    }, 30_000);
});
