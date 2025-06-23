/**
 * Test setup file for bun:test
 * This file is loaded before all tests and configures the testing environment
 */

import { beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test';
import { logger } from '@elizaos/core';
import { AgentServer } from '../index';
import path from 'node:path';
import fs from 'node:fs';

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests

// Global test server instance
let testServer: AgentServer | null = null;
let testDbPath: string | null = null;

// Expose test server for tests that need it
(global as any).testServer = null;
(global as any).getTestServer = async () => {
  if (!testServer) {
    testServer = new AgentServer();
    testDbPath = path.join(process.cwd(), '.eliza', 'test-db', `test-${Date.now()}`);
    
    // Initialize the server with test database
    await testServer.initialize({
      dataDir: testDbPath,
    });
    
    (global as any).testServer = testServer;
  }
  return testServer;
};

// Suppress console output during tests unless explicitly needed
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

beforeAll(() => {
  // Suppress console output during tests
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};

  // Configure logger for test environment
  logger.level = 'error';
  
  // Set test-specific environment variables
  process.env.PGLITE_DATA_DIR = path.join(process.cwd(), '.eliza', 'test-db');
  
  // Create test directories
  const testDataDir = path.join(process.cwd(), '.eliza', 'test-db');
  if (!fs.existsSync(testDataDir)) {
    fs.mkdirSync(testDataDir, { recursive: true });
  }
});

afterAll(async () => {
  // Restore console output
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.info = originalConsole.info;
  
  // Clean up test server if it was created
  if (testServer) {
    try {
      await testServer.stop();
    } catch (error) {
      // Ignore errors during cleanup
    }
  }
  
  // Clean up test database
  if (testDbPath && fs.existsSync(testDbPath)) {
    try {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  }
  
  // Clean up test data directory if empty
  const testDataDir = path.join(process.cwd(), '.eliza', 'test-db');
  if (fs.existsSync(testDataDir)) {
    try {
      const files = fs.readdirSync(testDataDir);
      if (files.length === 0) {
        fs.rmdirSync(testDataDir);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }
});

beforeEach(() => {
  // Clear any mocks before each test
  mock.restore?.();
});

afterEach(() => {
  // Clean up after each test
  mock.restore?.();
});

// Export test utilities
export const getTestDbPath = () => {
  const dbPath = path.join(process.cwd(), '.eliza', 'test-db', `test-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });
  return dbPath;
};
