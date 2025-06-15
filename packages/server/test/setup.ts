/**
 * Test setup file for vitest
 * This file is loaded before all tests and configures the testing environment
 */

import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { logger } from '@elizaos/core';

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests

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
});

afterAll(() => {
  // Restore console output
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.info = originalConsole.info;
});

beforeEach(() => {
  // Clear any mocks before each test
  vi.clearAllMocks?.();
});

afterEach(() => {
  // Clean up after each test
  vi.restoreAllMocks?.();
});