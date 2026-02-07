# Review: PR #553 — PTY Proxy for Local Mode Stdin Corruption

**PR**: fix: use PTY proxy for local mode to prevent stdin corruption after mode switch
**Author**: @mfazekas
**Status**: Draft
**Fixes**: #527, #423

## Summary

This PR fixes a critical UX bug where switching between remote and local modes
corrupts `process.stdin`, causing Node.js child processes spawned with
`stdio:'inherit'` to stop receiving keyboard input. The root cause is that Ink's
(and manual) manipulation of `process.stdin` encoding and raw mode leaves the
underlying libuv TTY handle in a broken state for subsequent child processes.

The fix has two complementary parts:

1. **Local mode (`claudeLocal.ts`)**: Replace `child_process.spawn()` with
   `node-pty` to give each local child its own isolated pseudo-terminal
2. **Remote mode (`claudeRemoteLauncher.ts`)**: Give Ink a separate `/dev/tty`
   file descriptor instead of letting it touch `process.stdin`

## Files Changed

| File | Change |
|------|--------|
| `packages/happy-cli/package.json` | Added `node-pty: ^1.1.0` dependency |
| `packages/happy-cli/scripts/claude_local_launcher.cjs` | IPC: fd 3 → Unix socket fallback |
| `packages/happy-cli/src/claude/claudeLocal.ts` | Major: spawn → PTY proxy + Unix socket IPC |
| `packages/happy-cli/src/claude/claudeLocalLauncher.ts` | Guard exit code overwrite on abort |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Separate /dev/tty fd for Ink |

## Approach Assessment

The two-pronged approach is architecturally sound:

- **PTY isolation** is the right fix for local mode. By giving each child its
  own PTY, the parent's stdin state becomes irrelevant.
- **Separate `/dev/tty` fd for Ink** prevents the root cause rather than trying
  to restore state after the fact.
- The **Unix socket IPC** to replace fd 3 is a necessary consequence of using
  `node-pty` (which doesn't support extra stdio pipes). The implementation is
  clean with proper readline-based JSON parsing.

## Issues Found

### Medium Priority

1. **Race condition with abort signal** (`claudeLocal.ts`)

   The abort handler is registered before `ptyProcess` is assigned. If the
   signal is already aborted, `ptyProcess` will be `null` and the kill is a
   no-op. Add a guard:
   ```ts
   if (opts.abort.aborted) {
       throw new Error('Already aborted');
   }
   ```

2. **Potential file descriptor leak** (`claudeRemoteLauncher.ts`)

   `inkStdinFd` is set to `null` without explicit `closeSync()`. If
   `ReadStream.destroy()` doesn't close the fd, you'd leak a file descriptor.
   Consider:
   ```ts
   if (inkStdinFd !== null) {
       try { closeSync(inkStdinFd); } catch {}
   }
   ```

3. **Dead cleanup code** (`claudeRemoteLauncher.ts`)

   `process.stdin.off('data', abort)` and `process.stdin.setRawMode(false)` are
   still in the finally block, but `process.stdin` is never put in raw mode in
   the new code. Remove these dead calls for clarity.

4. **Raw mode not restored on early throw** (`claudeLocal.ts`)

   If `claudeLocal` throws between `setRawMode(true)` and the `onExit` handler
   registering, stdin could be left in raw mode. The outer `finally` block
   doesn't restore it.

### Low Priority

5. **`node-pty` alphabetical ordering** (`package.json`)

   `node-pty` is inserted after `tweetnacl` but before `zod`. Should be between
   `ink` and `open` alphabetically.

6. **IPC socket connection timing** (`claude_local_launcher.cjs`)

   `net.createConnection()` is async but used synchronously in `writeMessage`.
   Unix domain sockets connect near-instantly so unlikely to be an issue in
   practice.

7. **Unix socket path length** (`claudeLocal.ts`)

   The socket path (~35 chars) is well within the 108-char `sun_path` limit, but
   worth being aware of for unusual `$TMPDIR` values.

## Missing Pieces

- **E2E tests are on a separate branch** (`test/pty-proxy-e2e`) — consider
  including them in this PR
- **Windows compatibility** — `/dev/tty` doesn't exist on Windows. If Windows
  isn't a target, document this. Otherwise, needs a fallback.
- **`node-pty` is a native addon** requiring build tools. Consider noting
  installation requirements or using `optionalDependencies` with a fallback.

## Verdict

**Approve with minor suggestions.**

The core approach is solid — PTY proxy addresses the root cause rather than
patching symptoms. The IPC migration from fd 3 to Unix sockets is cleanly done.
The fix directly addresses the root cause of issues #527 and #423.

Recommended before merge:
1. Guard against already-aborted signal before spawning PTY
2. Remove dead stdin cleanup in `claudeRemoteLauncher.ts`
3. Explicitly close `inkStdinFd` in cleanup
4. Include E2E tests from `test/pty-proxy-e2e` branch
5. Note Windows compatibility status
