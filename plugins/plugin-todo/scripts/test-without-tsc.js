#!/usr/bin/env node

import { execSync } from 'child_process';

console.log('Running tests without TypeScript validation...\n');

try {
  // Run unit tests
  console.log('Running unit tests...');
  execSync('bun run test:unit', { stdio: 'inherit' });
  
  // Run e2e tests
  console.log('\nRunning e2e tests...');
  execSync('bun run test:e2e:headless', { stdio: 'inherit' });
  
  console.log('\n✅ All tests completed!');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Tests failed');
  process.exit(1);
} 