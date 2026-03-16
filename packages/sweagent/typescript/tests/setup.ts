/**
 * Vitest test setup file
 * Common test utilities and configuration
 */

import * as path from "node:path";
import * as dotenv from "dotenv";
import { afterAll, expect, vi } from "vitest";
import { jest as jestCompat } from "./jest-globals";

// Load test environment variables
dotenv.config({ path: path.join(__dirname, "..", ".env.test") });

// Set test environment
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

// Jest compatibility: some converted tests reference global `jest`.
(globalThis as { jest: typeof jestCompat }).jest = jestCompat;

// Mock console methods to reduce test output noise
if (process.env.QUIET_TESTS === "true") {
  global.console = {
    ...console,
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// Add custom matchers if needed
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () =>
          `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
});

// Global test utilities
export const createMockHistory = () => [
  {
    role: "system",
    content: "You are a helpful assistant.",
    messageType: "thought" as const,
  },
  {
    role: "user",
    content: "Hello",
    messageType: "action" as const,
  },
];

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Clean up after tests
afterAll(async () => {
  // Ensure stdin doesn't keep the event loop alive (some code paths create
  // readline interfaces).
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("readable");
  process.stdin.pause();

  await delay(100);
});
