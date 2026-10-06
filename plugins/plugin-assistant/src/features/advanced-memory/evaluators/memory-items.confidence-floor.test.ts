/**
 * The long-term confidence floor must survive a non-finite configured
 * threshold (#31948): a NaN floor would compare false against every
 * confidence and store every extracted item. Deterministic, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
  LONG_TERM_CONFIDENCE_FLOOR,
  minimumStoredConfidence,
} from "./memory-items.ts";

describe("minimumStoredConfidence", () => {
  it("never drops below the floor and never becomes NaN", () => {
    expect(minimumStoredConfidence(0.5)).toBe(LONG_TERM_CONFIDENCE_FLOOR);
    expect(minimumStoredConfidence(0.95)).toBe(0.95);
    expect(minimumStoredConfidence(Number.NaN)).toBe(
      LONG_TERM_CONFIDENCE_FLOOR,
    );
    expect(minimumStoredConfidence(Number.POSITIVE_INFINITY)).toBe(
      LONG_TERM_CONFIDENCE_FLOOR,
    );
    expect(0.5 < minimumStoredConfidence(Number.NaN)).toBe(true);
  });
});
