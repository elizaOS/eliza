/**
 * Deterministic coverage for top-level Bags fee formatting helpers.
 */
import { describe, expect, test } from "bun:test";
import { formatSol } from "./bags-claimer";

describe("Bags fee claimer helpers", () => {
  test("formats lamports as fixed SOL values", () => {
    expect(formatSol(0)).toBe("0.0000");
    expect(formatSol(1_000_000)).toBe("0.0010");
    expect(formatSol(1_234_567_890)).toBe("1.2346");
  });
});
