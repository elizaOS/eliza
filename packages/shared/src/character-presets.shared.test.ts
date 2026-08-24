/**
 * Unit tests for shared character preset style rules.
 */

import { describe, expect, it } from "vitest";
import { SHARED_STYLE_RULES } from "./character-presets.shared.js";

describe("SHARED_STYLE_RULES", () => {
  it("contains all 7 canonical shared style rules", () => {
    expect(SHARED_STYLE_RULES).toHaveLength(7);
    expect(SHARED_STYLE_RULES).toEqual([
      "Keep it short unless the user clearly wants depth.",
      "Sound young, current, and self-aware without trying too hard.",
      "No assistant filler, no cringe, and no fake enthusiasm.",
      "Avoid metaphors, similes, and 'x is like y' phrasing.",
      "Address one person or a group directly when it fits.",
      "Read the register before replying: a bit gets one light line back, a low-effort message gets a low-effort reply or none.",
      "In group chats treat silence as a real option; if another assistant already answered, stay quiet until a human re-addresses you.",
    ]);
  });

  it("ensures all rules are non-empty trimmed strings", () => {
    for (const rule of SHARED_STYLE_RULES) {
      expect(typeof rule).toBe("string");
      expect(rule.trim().length).toBeGreaterThan(0);
      expect(rule).toBe(rule.trim());
    }
  });
});
