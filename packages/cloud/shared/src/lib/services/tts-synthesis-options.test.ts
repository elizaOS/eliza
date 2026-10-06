import { describe, expect, test } from "bun:test";
import { hasTtsSynthesisOptions, TtsSynthesisOptions } from "./tts-synthesis-options";

describe("speech rendering options", () => {
  test("accepts exact endpoints and preserves complete context", () => {
    for (const speed of [0.7, 0.8, 0.9, 1, 1.1, 1.2]) {
      const value = {
        speed,
        previousText: "A previous sentence.",
        nextText: "x".repeat(5000),
        applyTextNormalization: "on",
      };
      expect(TtsSynthesisOptions.parse(value)).toEqual(value);
    }
  });
  test("rejects coercion, out of range speed, unknown policy and oversized context", () => {
    for (const value of [
      { speed: "1" },
      { speed: 0.69 },
      { speed: 1.21 },
      { speed: NaN },
      { speed: Infinity },
      { speed: null },
      { previousText: "x".repeat(5001) },
      { nextText: "x".repeat(5001) },
      { previousText: 1 },
      { applyTextNormalization: "yes" },
    ]) {
      expect(TtsSynthesisOptions.safeParse(value).success).toBe(false);
    }
  });
  test("every explicit rendering option bypasses legacy audio cache", () => {
    expect(hasTtsSynthesisOptions({})).toBe(false);
    for (const value of [
      { speed: 1 },
      { previousText: "" },
      { nextText: "" },
      { applyTextNormalization: "auto" as const },
      { applyTextNormalization: "off" as const },
    ]) {
      expect(hasTtsSynthesisOptions(value)).toBe(true);
    }
  });
});
