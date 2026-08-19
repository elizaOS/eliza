/**
 * Isolated overflow tests for the `$include` file byte budget. Deterministic —
 * no filesystem, JSON5, or character-config loader.
 */
import { describe, expect, it } from "vitest";
import {
  isIncludeFileTooLarge,
  MAX_INCLUDE_BYTES,
} from "./include-file-budget.ts";

describe("isIncludeFileTooLarge", () => {
  it("accepts an honest small include", () => {
    expect(isIncludeFileTooLarge('{ "name": "ok" }\n')).toBe(false);
    expect(isIncludeFileTooLarge("x".repeat(MAX_INCLUDE_BYTES))).toBe(false);
  });

  it("rejects a file one byte over the budget", () => {
    expect(isIncludeFileTooLarge("x".repeat(MAX_INCLUDE_BYTES + 1))).toBe(true);
  });
});
