import { expect } from "vitest";

/** Fails the test when value is null/undefined; avoids non-null assertions for Biome. */
export function assertNonNull<T>(value: T | null | undefined, message?: string): T {
  expect(value).not.toBeNull();
  expect(value).toBeDefined();
  if (value === null || value === undefined) {
    throw new Error(message ?? "expected non-null value");
  }
  return value;
}
