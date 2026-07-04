/**
 * Unit test for `normalizeCharacterLanguage`: covers canonical pass-through,
 * Chinese-variant collapsing, regional/script-tag normalization (incl.
 * `fil`→`tl`), whitespace trimming, and the `en` fallback for unknown or
 * non-string input. Pure string logic, no mocks.
 */
import { describe, expect, it } from "vitest";
import { normalizeCharacterLanguage } from "./character-language";

/**
 * `normalizeCharacterLanguage` is on the eager renderer path (the i18n keyword
 * matcher) and coerces any locale-ish string into one of the 7 supported
 * `CharacterLanguage` values. It had no test, so a regression in the
 * variant/alias rules (e.g. `fil`→`tl`, `zh-Hans`→`zh-CN`) would silently
 * mis-route a character's reply language. Pure string logic.
 */
describe("normalizeCharacterLanguage", () => {
  it("passes an exact canonical language through unchanged", () => {
    expect(normalizeCharacterLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeCharacterLanguage("es")).toBe("es");
    expect(normalizeCharacterLanguage("tl")).toBe("tl");
    expect(normalizeCharacterLanguage("en")).toBe("en");
  });

  it("collapses every Chinese variant onto zh-CN", () => {
    for (const v of ["zh", "ZH", "zh-cn", "zh-Hans", "zh-hans-foo"]) {
      expect(normalizeCharacterLanguage(v)).toBe("zh-CN");
    }
  });

  it("normalizes regional/script tags by language prefix", () => {
    expect(normalizeCharacterLanguage("ko-KR")).toBe("ko");
    expect(normalizeCharacterLanguage("pt-BR")).toBe("pt");
    expect(normalizeCharacterLanguage("es-419")).toBe("es");
    expect(normalizeCharacterLanguage("vi-VN")).toBe("vi");
    // Tagalog has two prefixes — its own and the legacy `fil`.
    expect(normalizeCharacterLanguage("fil")).toBe("tl");
    expect(normalizeCharacterLanguage("fil-PH")).toBe("tl");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeCharacterLanguage("  ko  ")).toBe("ko");
  });

  it("falls back to en for unknown, empty, or non-string input", () => {
    expect(normalizeCharacterLanguage("de")).toBe("en");
    expect(normalizeCharacterLanguage("xyz")).toBe("en");
    expect(normalizeCharacterLanguage("")).toBe("en");
    expect(normalizeCharacterLanguage("   ")).toBe("en");
    expect(normalizeCharacterLanguage(null)).toBe("en");
    expect(normalizeCharacterLanguage(undefined)).toBe("en");
    expect(normalizeCharacterLanguage(42)).toBe("en");
    expect(normalizeCharacterLanguage({})).toBe("en");
  });
});
