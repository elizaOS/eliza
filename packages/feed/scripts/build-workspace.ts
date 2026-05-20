#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

type BuildStep = {
  name: string;
  cwd: string;
  command: string;
  args: string[];
};

const repoRoot = resolve(import.meta.dir, '..');

const steps: BuildStep[] = [
  {
    name: 'packages/examples/local-a2a-server',
    cwd: resolve(repoRoot, 'packages/examples/local-a2a-server'),
    command: 'bun',
    args: ['run', 'build'],
  },
  {
    name: 'packages/sim',
    cwd: resolve(repoRoot, 'packages/sim'),
    command: 'bun',
    args: ['run', 'build'],
  },
  {
    name: 'apps/cli',
    cwd: resolve(repoRoot, 'apps/cli'),
    command: 'bun',
    args: ['run', 'build'],
  },
  {
    name: 'apps/web',
    cwd: resolve(repoRoot, 'apps/web'),
    command: 'bun',
    args: ['run', 'build'],
  },
];

for (const step of steps) {
  console.log(`\n=== Building ${step.name} ===`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Build failed for ${step.name}:`, result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
