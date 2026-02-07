#!/usr/bin/env node
/**
 * Test child process that reads stdin in raw mode and logs every character
 * to a JSONL file. Used as a "canary" in e2e tests — if it receives chars,
 * stdin works; if not, stdin is broken.
 *
 * Usage: node test-stdin-logger.mjs <output-file>
 */

import { appendFileSync } from 'node:fs';

const outputPath = process.argv[2];
if (!outputPath) {
    process.stderr.write('Usage: node test-stdin-logger.mjs <output-file>\n');
    process.exit(1);
}

function logEntry(obj) {
    appendFileSync(outputPath, JSON.stringify(obj) + '\n');
}

logEntry({ type: 'start', pid: process.pid, time: Date.now() });

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    for (const ch of chunk) {
        logEntry({
            type: 'char',
            char: ch,
            code: ch.charCodeAt(0),
            time: Date.now()
        });
        // Echo the character back so PTY tests can also detect it via output
        process.stdout.write(ch);
    }
});

process.stdin.on('end', () => {
    logEntry({ type: 'end', time: Date.now() });
});

process.stdin.resume();
