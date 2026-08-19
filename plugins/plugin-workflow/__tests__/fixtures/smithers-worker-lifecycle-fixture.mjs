#!/usr/bin/env node
/** Simulates hostile and truncated Smithers workers for subprocess lifecycle tests. */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const prefix = '__ELIZA_SMTHRS__';
const payload = JSON.parse(readFileSync(process.env.ELIZA_SMTHRS_PAYLOAD_PATH, 'utf8'));
const mode = payload.input.fixtureMode;
const emit = (message) => process.stdout.write(`${prefix}${JSON.stringify(message)}\n`);

if (mode === 'ignore-termination') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else if (mode === 'exit-with-inherited-pipe') {
  spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 5000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  }).unref();
  setTimeout(() => process.exit(0), Number(payload.input.exitDelayMs ?? 0));
} else if (mode === 'exit-with-pending-agent-request') {
  emit({
    kind: 'agent-request',
    requestId: 'never-answered',
    prompt: 'request that outlives the worker',
  });
  setTimeout(() => process.exit(0), 10);
} else if (mode === 'closed-input-result') {
  process.stdin.destroy();
  setTimeout(() => {
    emit({
      kind: 'agent-request',
      requestId: 'late-request',
      prompt: 'reply after stdin closes',
    });
  }, 10);
  setTimeout(() => {
    emit({ kind: 'result', result: { runId: payload.runId, status: 'finished' } });
    process.exit(0);
  }, 100);
} else if (mode === 'oversized-stdout-line') {
  process.stdout.write('x'.repeat(Number(payload.input.outputBytes)));
} else {
  throw new Error(`Unknown fixture mode: ${String(mode)}`);
}
