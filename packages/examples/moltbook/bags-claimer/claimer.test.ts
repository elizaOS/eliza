/**
 * Deterministic coverage for nested Bags fee formatting helpers.
 */
import { describe, expect, test } from "bun:test";
import { formatSol } from "./claimer";

describe("nested Bags claimer helpers", () => {
  test("formats lamports as fixed SOL values", () => {
    expect(formatSol(1_000_000)).toBe("0.0010");
    expect(formatSol(2_500_000_000)).toBe("2.5000");
  });
});
