/**
 * Unit tests for the React-free language-normalization surface that Node route
 * handlers depend on (moved here from `@elizaos/ui/i18n` in #12410).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_LANGUAGE,
  normalizeLanguage,
  UI_LANGUAGES,
} from "./language.js";

describe("normalizeLanguage", () => {
  it("passes through exact supported codes", () => {
    for (const lang of UI_LANGUAGES) {
      expect(normalizeLanguage(lang)).toBe(lang);
    }
  });

  it("maps regional BCP-47 tags onto the base supported language", () => {
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("zh")).toBe("zh-CN");
    expect(normalizeLanguage("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLanguage("ko-KR")).toBe("ko");
    expect(normalizeLanguage("pt-BR")).toBe("pt");
    expect(normalizeLanguage("fil-PH")).toBe("tl");
    expect(normalizeLanguage("  ja  ")).toBe("ja");
  });

  it("falls back to the default for unsupported or non-string input", () => {
    expect(normalizeLanguage("de")).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeLanguage("")).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeLanguage(42)).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeLanguage(null)).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeLanguage(undefined)).toBe(DEFAULT_UI_LANGUAGE);
  });
});
