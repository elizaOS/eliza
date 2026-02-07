/**
 * Test utility stubs — recreated to unblock the build.
 */

import type { Memory, UUID } from "../types";

export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: crypto.randomUUID() as UUID,
    agentId: crypto.randomUUID() as UUID,
    roomId: crypto.randomUUID() as UUID,
    content: { text: "test memory" },
    createdAt: Date.now(),
    ...overrides,
  } as Memory;
}

export function expectRejection(
  fn: () => Promise<unknown>,
  errorPattern?: RegExp,
): Promise<void> {
  return fn().then(
    () => {
      throw new Error("Expected promise to reject but it resolved");
    },
    (err: Error) => {
      if (errorPattern && !errorPattern.test(err.message)) {
        throw new Error(
          `Expected error matching ${errorPattern} but got: ${err.message}`,
        );
      }
    },
  );
}

export function generateTestId(): string {
  return crypto.randomUUID();
}

export async function measureTime<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 100,
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (i < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export const testDataGenerators = {
  uuid: () => crypto.randomUUID(),
  text: (prefix = "test") =>
    `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
  number: (min = 0, max = 100) =>
    Math.floor(Math.random() * (max - min + 1)) + min,
};

export async function waitFor(
  conditionFn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  pollMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
