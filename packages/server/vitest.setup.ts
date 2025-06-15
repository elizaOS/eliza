/**
 * Vitest setup file
 * This runs before any test files are loaded
 */

import { vi, beforeEach, afterAll } from 'vitest';

// Make vi available globally
(globalThis as any).vi = vi;

// Setup any global test utilities or configurations here
beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks();
});

// Clean up after all tests
afterAll(() => {
  // Clean up any global state
  vi.restoreAllMocks();
}); 