// Test script to verify tryLoadFile fix
const path = require('path');

// First, let's create a mock server module since the actual one might not be built
const mockServerModule = {
  tryLoadFile: (filePath) => {
    // Simulate the server's tryLoadFile implementation
    const fs = require('fs');
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      throw new Error(`Error loading file ${filePath}: ${e}`);
    }
  }
};

// Mock the require call for @elizaos/server
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id) {
  if (id === '@elizaos/server') {
    return mockServerModule;
  }
  return originalRequire.apply(this, arguments);
};

// Now test our loader
const { tryLoadFile } = require('./packages/cli/dist/commands/start/utils/loader.js');

// Create a test file
const fs = require('fs');
const testFile = 'test-file.txt';
const testContent = 'Hello, this is a test file!';
fs.writeFileSync(testFile, testContent);

try {
  // Test 1: Successfully load a file
  console.log('Test 1: Loading existing file...');
  const result = tryLoadFile(testFile);
  if (result === testContent) {
    console.log('✓ Test 1 passed: File loaded successfully');
  } else {
    console.log(`✗ Test 1 failed: Expected "${testContent}", got "${result}"`);
  }

  // Test 2: Verify function is synchronous
  console.log('\nTest 2: Verifying synchronous behavior...');
  const returnValue = tryLoadFile(testFile);
  if (typeof returnValue === 'string' && !(returnValue instanceof Promise)) {
    console.log('✓ Test 2 passed: Function returns string synchronously');
  } else {
    console.log('✗ Test 2 failed: Function is not synchronous');
  }

  // Test 3: Error handling
  console.log('\nTest 3: Testing error handling...');
  try {
    tryLoadFile('nonexistent-file.txt');
    console.log('✗ Test 3 failed: Should have thrown an error');
  } catch (e) {
    if (e.message.includes('Error loading file')) {
      console.log('✓ Test 3 passed: Error thrown correctly');
    } else {
      console.log(`✗ Test 3 failed: Unexpected error: ${e.message}`);
    }
  }

} finally {
  // Clean up
  fs.unlinkSync(testFile);
  console.log('\nTest file cleaned up.');
}