#!/usr/bin/env node

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Get the current directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

// Get arguments
const args = process.argv.slice(2);
const runE2E = args.includes('--e2e');
const runLive = args.includes('--live');
const runAll = args.includes('--all');
const watch = args.includes('--watch');

console.log(`${colors.bright}${colors.cyan}Running Registry Publishing Tests${colors.reset}\n`);

// Determine test files to run
const testFiles = ['registry-publishing.test.js'];

// If --all flag is used, run both unit and E2E tests
if (runAll || runE2E) {
  testFiles.push('registry-e2e.test.js');
  console.log(`${colors.yellow}Including E2E tests${colors.reset}`);
}

// Log the test files that will be run
console.log(`${colors.yellow}Running tests: ${testFiles.join(', ')}${colors.reset}`);

if (runLive) {
  console.log(`${colors.yellow}Running with live tests enabled${colors.reset}`);
}

// Build the test command
let testCmd;

if (runAll) {
  // If --all flag is used, hardcode both test files
  testCmd = `npx vitest run registry-publishing.test.js registry-e2e.test.js`;
  console.log(`${colors.yellow}Running all tests (unit + E2E)${colors.reset}`);
} else {
  // Otherwise use the testFiles array
  testCmd = `npx vitest run ${testFiles.join(' ')}`;
}

if (watch) {
  // If watch mode is enabled, modify the command
  if (runAll) {
    testCmd = `npx vitest watch registry-publishing.test.js registry-e2e.test.js`;
  } else {
    testCmd = `npx vitest watch ${testFiles.join(' ')}`;
  }
  console.log(`${colors.yellow}Running in watch mode${colors.reset}`);
}

// Debug the constructed command
console.log(`${colors.yellow}Constructed test command: ${testCmd}${colors.reset}`);

// Simplified environment variables for test control
// Use a single environment variable to control E2E tests
// Use a separate environment variable to control live tests
const env = {
  ...process.env,
  // Toggle E2E tests on/off with a single environment variable
  RUN_E2E_TESTS: runE2E || runAll ? 'true' : 'false',
  RUN_LIVE_TESTS: runLive ? 'true' : 'false',
  // Force skip E2E tests unless explicitly enabled
  FORCE_RUN_E2E: runE2E || runAll ? 'true' : 'false',
};

// Options for the process
const options = {
  env,
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
};

try {
  console.log(`${colors.green}Executing: ${testCmd}${colors.reset}\n`);
  execSync(testCmd, options);
  console.log(`\n${colors.green}${colors.bright}✓ All tests passed!${colors.reset}`);
} catch (error) {
  console.error(`\n${colors.red}${colors.bright}✗ Tests failed!${colors.reset}`);
  process.exit(1);
}
