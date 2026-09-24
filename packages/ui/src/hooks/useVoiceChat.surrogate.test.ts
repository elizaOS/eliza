/**
 * Surrogate-safe TTS preview truncation for useVoiceChat hook.
 * Mirrors tts-debug.ts pattern: truncateWellFormed(toWellFormedUnicode) so caps landing mid-emoji back off.
 */
import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  formatNamedVoiceError,
  formatVoiceErrorPreview,
} from "./voice-error-preview";

const isWellFormed = (s: string): boolean => {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
};

describe("useVoiceChat TTS preview surrogate safety", () => {
  const ROCKET = "🦊"; // surrogate pair, 2 code units
  const LONE_HIGH_SURROGATE = "\ud83d";

  it("backs off when 80 cap lands mid-pair", () => {
    const input = `${"a".repeat(79)}${ROCKET}${"b".repeat(20)}`;
    const out = formatVoiceErrorPreview(input, 80);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(79);
    expect(out.endsWith("\ud83e") || out.endsWith("\ud83d")).toBe(false);
  });

  it("backs off when 120 cap lands mid-pair", () => {
    const input = `${"a".repeat(119)}${ROCKET}${"b".repeat(20)}`;
    const out = formatVoiceErrorPreview(input, 120);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(119);
  });

  it("backs off when 200 cap lands mid-pair", () => {
    const input = `${"a".repeat(199)}${ROCKET}${"b".repeat(20)}`;
    const out = formatVoiceErrorPreview(input, 200);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(199);
  });

  it("preserves fitting emoji at caps", () => {
    expect(formatVoiceErrorPreview(`${"a".repeat(78)}${ROCKET}`, 80)).toBe(
      `${"a".repeat(78)}${ROCKET}`,
    );
    expect(formatVoiceErrorPreview(`${"a".repeat(118)}${ROCKET}`, 120)).toBe(
      `${"a".repeat(118)}${ROCKET}`,
    );
    expect(formatVoiceErrorPreview(`${"a".repeat(198)}${ROCKET}`, 200)).toBe(
      `${"a".repeat(198)}${ROCKET}`,
    );
  });

  it("sweep 0..65 at 80 stays well-formed", () => {
    for (let off = 0; off <= 65; off++) {
      const input = `${"a".repeat(off)}${ROCKET}${"b".repeat(100)}`;
      const out = formatVoiceErrorPreview(input, 80);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("sanitizes lone surrogate to U+FFFD", () => {
    const out = formatVoiceErrorPreview(`ok \ud83d end ${"x".repeat(200)}`, 80);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud83d")).toBe(false);
    expect(out.includes("�")).toBe(true);
  });

  it("formats the complete named queue/debug error through the production formatter", () => {
    const error = new TypeError(`${"q".repeat(188)}${ROCKET}ignored`);
    error.name = `Type${LONE_HIGH_SURROGATE}Error`;
    const preview = formatNamedVoiceError(error);

    expect(preview).toContain("Type�Error: ");
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(isWellFormed(preview)).toBe(true);
  });
});
