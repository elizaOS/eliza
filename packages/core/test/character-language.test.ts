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
});
