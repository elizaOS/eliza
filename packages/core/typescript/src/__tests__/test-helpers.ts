/**
 * Test Helper Utilities for Core Package Tests
 *
 * IMPORTANT: This file should only contain utilities for:
 * 1. Generating test data (UUIDs, timestamps)
 * 2. Timing/waiting utilities
 * 3. Type-safe test data factories
 *
 * DO NOT add mock factories here. For integration testing:
 * - Use @elizaos/plugin-sql with PGLite for real database
 * - Use real runtime initialization
 */

import type { UUID } from "../types";
import { stringToUuid } from "../utils";

/**
 * Generate a unique test UUID based on timestamp and random component
 */
export function generateTestUUID(): UUID {
  return stringToUuid(
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Wait for a condition to be true with timeout
 * @throws Error if condition is not met within timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Measure execution time of an async function
 */
export async function measureTime<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

/**
 * Create a deterministic UUID from a test identifier
 * Useful for consistent test data across runs
 */
export function testUuid(identifier: string): UUID {
  return stringToUuid(`test-${identifier}`);
}
