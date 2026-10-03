/**
 * Regression coverage for the TTS speech sanitizer's compatibility
 * normalization. NFKC must not erase the numero sign (U+2116) before the
 * language-aware voice stage can interpret it, while ordinary Latin text
 * (`No4`) and unrelated compatibility folding keep their existing behavior.
 */

import { describe, expect, it } from "vitest";
import { sanitizeSpeechText } from "./spoken-text.ts";

describe("sanitizeSpeechText numero sign normalization", () => {
	it("preserves the numero sign instead of folding it to Latin No", () => {
		expect(sanitizeSpeechText("№4")).toBe("№4");
		expect(sanitizeSpeechText("№1")).toBe("№1");
		expect(sanitizeSpeechText("№12")).toBe("№12");
		expect(sanitizeSpeechText("№21")).toBe("№21");
	});

	it("keeps the numero token through a mixed-language sentence", () => {
		expect(sanitizeSpeechText("Заметка №4 создана.")).toBe(
			"Заметка №4 создана.",
		);
	});

	it("preserves each token when several appear in one line", () => {
		expect(sanitizeSpeechText("Items №1 and №21")).toBe("Items №1 and №21");
	});

	it("does not rewrite a literal Latin No4", () => {
		expect(sanitizeSpeechText("No4")).toBe("No4");
		expect(sanitizeSpeechText("See No4 here")).toBe("See No4 here");
	});

	it("preserves adjacent numero tokens without spaces", () => {
		expect(sanitizeSpeechText("№4№5")).toBe("№4№5");
	});

	it("keeps the numero token while stripping surrounding punctuation", () => {
		expect(sanitizeSpeechText("Note: №4, done.")).toBe("Note: №4, done.");
	});

	it("still NFKC-folds unrelated compatibility characters", () => {
		expect(sanitizeSpeechText("ＨＥＬＬＯ")).toBe("HELLO");
		expect(sanitizeSpeechText("１２３")).toBe("123");
	});
});
