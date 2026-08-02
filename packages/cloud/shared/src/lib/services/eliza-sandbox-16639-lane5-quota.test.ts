/**
 * Runs the coding-container quota suite without the sandbox suites whose
 * PGlite and module state collide when Bun composes them in one process.
 * Keeping this as an independent test entry preserves package-runner coverage
 * without coupling unrelated suite fixtures.
 */
import { describe, expect, test } from "bun:test";
import "./__tests__/eliza-sandbox-coding-container-quota.test.ts";

describe("eliza-sandbox composite lane 5 (coding-container quota)", () => {
  test("runs under bun with its composed suite", () => {
    expect(typeof test).toBe("function");
  });
});
