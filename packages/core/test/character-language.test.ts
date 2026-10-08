import { describe, expect, it } from "vitest";
import {
	addLanguageRule,
	normalizeCharacterLanguage,
} from "../src/character-language.ts";

describe("normalizeCharacterLanguage", () => {
	it("keeps Japanese instead of falling back to English", () => {
		expect(normalizeCharacterLanguage("ja")).toBe("ja");
		expect(normalizeCharacterLanguage("ja-JP")).toBe("ja");
		expect(addLanguageRule("Stay helpful.", "ja")).toContain(
			"natural Japanese",
		);
	});

	it("maps Traditional Chinese tags to the Chinese reply language", () => {
		expect(normalizeCharacterLanguage("zh-TW")).toBe("zh-CN");
		expect(normalizeCharacterLanguage("zh-HK")).toBe("zh-CN");
		expect(normalizeCharacterLanguage("zh-Hant")).toBe("zh-CN");
		expect(addLanguageRule("Stay helpful.", "zh-CN")).toContain(
			"simplified Chinese",
		);
	});
});
