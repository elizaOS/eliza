/**
 * Coverage for character-language.
 */
import { describe, expect, it } from "vitest";
import {
  addLanguageRule,
  DEFAULT_CHARACTER_LANGUAGE,
  LANGUAGE_REPLY_RULES,
  normalizeCharacterLanguage,
} from "./character-language.js";

describe("character-language", () => {
  it("exposes the default language and per-language reply rules", () => {
    expect(DEFAULT_CHARACTER_LANGUAGE).toBe("en");
    expect(Object.keys(LANGUAGE_REPLY_RULES)).toContain("en");
    expect(Object.keys(LANGUAGE_REPLY_RULES)).toContain("zh-CN");
  });

  it("normalizes exact matches and case", () => {
    expect(normalizeCharacterLanguage("en")).toBe("en");
    expect(normalizeCharacterLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeCharacterLanguage("ZH-CN")).toBe("zh-CN");
    expect(normalizeCharacterLanguage("ES")).toBe("es");
  });

  it("normalizes aliases (zh → zh-CN, zh-hans → zh-CN, ko/es prefixes)", () => {
    expect(normalizeCharacterLanguage("zh")).toBe("zh-CN");
    expect(normalizeCharacterLanguage("zh-hans")).toBe("zh-CN");
    expect(normalizeCharacterLanguage("korean")).toBe("ko");
    expect(normalizeCharacterLanguage("español")).toBe("es");
  });

  it("falls back to default for non-string, empty, and unknown input", () => {
    expect(normalizeCharacterLanguage(undefined)).toBe("en");
    expect(normalizeCharacterLanguage(42)).toBe("en");
    expect(normalizeCharacterLanguage("  ")).toBe("en");
    expect(normalizeCharacterLanguage("xx")).toBe("en");
  });

  it("appends the language rule to a system prompt", () => {
    const out = addLanguageRule("Be helpful.", "zh-CN");
    expect(out.startsWith("Be helpful.")).toBe(true);
    expect(out).toContain("simplified Chinese");
  });
});
