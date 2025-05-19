#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const cliPath = (await import.meta.resolve('@elizaos/cli')).replace('file://', '');

const rawArgs = process.argv.slice(2);
const args = ['create', ...rawArgs];

console.log(`Running: elizaos ${args.join(' ')}`);
const result = spawnSync(cliPath, args, { stdio: 'inherit' });
process.exit(result.status);
