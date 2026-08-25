/**
 * Unit tests for built-in character definitions and localization variants data table.
 */

import { describe, expect, it } from "vitest";
import { CHARACTER_DEFINITIONS } from "./character-presets.characters.js";

const REQUIRED_LANGUAGES = [
  "en",
  "zh-CN",
  "ko",
  "es",
  "pt",
  "vi",
  "tl",
] as const;

describe("character-presets.characters", () => {
  it("contains unique valid character definition records", () => {
    expect(CHARACTER_DEFINITIONS.length).toBeGreaterThan(0);

    const ids = new Set<string>();
    for (const char of CHARACTER_DEFINITIONS) {
      expect(char.id).toBeDefined();
      expect(typeof char.id).toBe("string");
      expect(ids.has(char.id)).toBe(false);
      ids.add(char.id);

      expect(char.name).toBeDefined();
      expect(typeof char.name).toBe("string");
      expect(Array.isArray(char.bio)).toBe(true);
      expect(char.bio.length).toBeGreaterThan(0);
      expect(typeof char.system).toBe("string");
      expect(Array.isArray(char.adjectives)).toBe(true);
      expect(Array.isArray(char.topics)).toBe(true);
      expect(Array.isArray(char.messageExamples)).toBe(true);
      expect(char.style).toBeDefined();
      expect(Array.isArray(char.style.all)).toBe(true);
      expect(Array.isArray(char.style.chat)).toBe(true);
      expect(Array.isArray(char.style.post)).toBe(true);
    }
  });

  it("includes all supported language variants for each character", () => {
    for (const char of CHARACTER_DEFINITIONS) {
      expect(char.variants).toBeDefined();
      for (const lang of REQUIRED_LANGUAGES) {
        const variant = char.variants[lang];
        expect(variant).toBeDefined();
        expect(typeof variant.catchphrase).toBe("string");
        expect(variant.catchphrase.length).toBeGreaterThan(0);
        expect(typeof variant.hint).toBe("string");
        expect(variant.hint.length).toBeGreaterThan(0);
        expect(Array.isArray(variant.postExamples)).toBe(true);
      }
    }
  });

  it("includes the canonical default eliza persona with templates", () => {
    const eliza = CHARACTER_DEFINITIONS.find((c) => c.id === "eliza");
    expect(eliza).toBeDefined();
    expect(eliza?.name).toBe("Eliza");
    expect(eliza?.templates).toBeDefined();
    expect(eliza?.templates?.authFailedReply).toBeDefined();
    expect(eliza?.templates?.rateLimitedReply).toBeDefined();
  });
});
