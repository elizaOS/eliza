#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

const WORKSPACES = [
  'packages/shared',
  'packages/db',
  'packages/core',
  'packages/pack-default',
  'packages/api',
  'packages/a2a',
  'packages/mcp',
  'packages/engine',
  'packages/training',
  'packages/agents',
  'packages/testing',
  'packages/sim',
  'packages/examples/local-a2a-server',
  'packages/examples/feed-typescript-agent',
  'apps/cli',
  'apps/web',
] as const;

async function runTypecheck(workspace: string): Promise<void> {
  process.stdout.write(`\n[${workspace}] typecheck\n`);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('bun', ['run', '--cwd', workspace, 'typecheck'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${workspace} typecheck failed with code ${code ?? 'null'}`)
      );
    });
  });
}

// Bootstrap agents declarations to break circular dependency with api.
// api resolves @feed/agents/* from agents/dist, but agents references api
// via project refs. Emit agents .d.ts without type-checking so api can resolve
// its imports before the full typecheck sequence runs.
process.stdout.write('\n[packages/agents] emitting declarations (bootstrap)\n');
await new Promise<void>((resolvePromise, rejectPromise) => {
  const child = spawn(
    'bun',
    [
      'run',
      'tsc',
      '-p',
      'packages/agents',
      '--emitDeclarationOnly',
      '--noCheck',
    ],
    { cwd: ROOT, stdio: 'inherit', env: process.env }
  );
  child.on('error', rejectPromise);
  child.on('exit', (code) => {
    if (code === 0) {
      resolvePromise();
      return;
    }
    rejectPromise(
      new Error(
        `agents declaration bootstrap failed with code ${code ?? 'null'}`
      )
    );
  });
});

for (const workspace of WORKSPACES) {
  await runTypecheck(workspace);
}

process.stdout.write('\nAll workspace typechecks passed.\n');
