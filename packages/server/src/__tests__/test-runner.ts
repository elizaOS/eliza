#!/usr/bin/env bun
/**
 * Test runner for server package
 * Ensures proper test isolation and server lifecycle management
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { Glob } from 'bun';

const isIntegrationTest = process.argv.includes('--integration');
const isUnitTest = process.argv.includes('--unit') || !isIntegrationTest;

// Clean up any existing test databases before starting
const testDbDir = path.join(process.cwd(), '.eliza', 'test-db');
if (fs.existsSync(testDbDir)) {
  fs.rmSync(testDbDir, { recursive: true, force: true });
}

// Set up test environment
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

async function getTestFiles(): Promise<string[]> {
  const glob = new Glob('src/**/*.test.ts');
  const allTestFiles: string[] = [];
  
  for await (const file of glob.scan({ cwd: process.cwd() })) {
    allTestFiles.push(file);
  }
  
  if (isUnitTest && !isIntegrationTest) {
    // Filter out integration tests
    return allTestFiles.filter(file => !file.includes('/__tests__/integration/'));
  } else if (isIntegrationTest) {
    // Only include integration tests
    return allTestFiles.filter(file => file.includes('/__tests__/integration/'));
  }
  
  return allTestFiles;
}

async function runTests() {
  const testFiles = await getTestFiles();
  
  if (testFiles.length === 0) {
    console.log('No test files found matching criteria');
    process.exit(0);
  }
  
  console.log(`Running ${isIntegrationTest ? 'integration' : 'unit'} tests...`);
  console.log(`Found ${testFiles.length} test files`);
  
  // Run tests with appropriate configuration
  const args = ['test', ...testFiles, ...process.argv.slice(2).filter(arg => !arg.startsWith('--'))];
  
  const testProcess = spawn('bun', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORCE_COLOR: '1',
    } as any,
  });
  
  testProcess.on('exit', (code) => {
    // Clean up test databases after tests complete
    if (fs.existsSync(testDbDir)) {
      try {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      } catch (error) {
        console.error('Failed to clean up test databases:', error);
      }
    }
    
    process.exit(code || 0);
  });
}

runTests().catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
}); 