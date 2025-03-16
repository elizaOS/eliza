#!/usr/bin/env node

import { spawn } from 'node:child_process';

const cliPath = (await import.meta.resolve('@elizaos/cli')).replace('file://', '');

console.log(cliPath);

// spawn the cli
spawn(cliPath, ['create'], { stdio: 'inherit' });
