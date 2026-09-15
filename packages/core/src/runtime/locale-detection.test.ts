/**
 * Unit tests for locale detection: validates CJK character detection,
 * Spanish/French vocabulary scoring, diacritics, and owner fallback priority.
 */
import { describe, expect, it } from "vitest";
import {
	detectLocaleFromText,
	resolveOwnerLocale,
} from "./locale-detection.ts";

describe("locale-detection", () => {
	describe("detectLocaleFromText", () => {
		it("returns null for empty or non-string input", () => {
			expect(detectLocaleFromText("")).toBeNull();
			expect(detectLocaleFromText("   ")).toBeNull();
			expect(detectLocaleFromText(null)).toBeNull();
			expect(detectLocaleFromText(undefined)).toBeNull();
		});

		it("detects Japanese from Kana characters", () => {
			expect(detectLocaleFromText("\u3053\u3093\u306b\u3061\u306f")).toBe("ja");
			expect(detectLocaleFromText("Hello \u3042\u308a\u304c\u3068\u3046")).toBe(
				"ja",
			);
		});

		it("detects Simplified Chinese from Han characters without kana", () => {
			expect(detectLocaleFromText("\u4f60\u597d\u4e16\u754c")).toBe("zh-Hans");
		});

		it("detects Spanish from vocabulary and diacritics", () => {
			expect(
				detectLocaleFromText("Hola, muchas gracias por su ayuda hoy"),
			).toBe("es");
			expect(detectLocaleFromText("\u00bfC\u00f3mo est\u00e1s hoy?")).toBe(
				"es",
			);
		});

		it("detects French from vocabulary and diacritics", () => {
			expect(
				detectLocaleFromText("Bonjour, merci beaucoup pour votre aide"),
			).toBe("fr");
			expect(
				detectLocaleFromText("Rappelle-moi demain matin s'il vous pla\u00eet"),
			).toBe("fr");
		});

		it("returns null when no distinct signal is found", () => {
			expect(detectLocaleFromText("12345 67890")).toBeNull();
			expect(detectLocaleFromText("foo bar baz")).toBeNull();
		});
	});

	describe("resolveOwnerLocale", () => {
		it("prefers canonical ownerLocale when present", () => {
			const res = resolveOwnerLocale({
				ownerLocale: "es",
				recentMessage: "Bonjour tout le monde",
				defaultLocale: "en",
			});
			expect(res).toBe("es");
		});

		it("falls back to detected locale from recentMessage", () => {
			const res = resolveOwnerLocale({
				ownerLocale: null,
				recentMessage: "Bonjour, merci pour l'aide",
				defaultLocale: "en",
			});
			expect(res).toBe("fr");
		});

		it("falls back to defaultLocale when no signal is present", () => {
			const res = resolveOwnerLocale({
				ownerLocale: undefined,
				recentMessage: "xyz 123",
				defaultLocale: "ja",
			});
			expect(res).toBe("ja");
		});

		it("defaults to 'en' when defaultLocale is omitted", () => {
			const res = resolveOwnerLocale({
				ownerLocale: undefined,
				recentMessage: undefined,
			});
			expect(res).toBe("en");
		});
	});
});

describe("locale-detection (edge cases)", () => {
	describe("detectLocaleFromText", () => {
		it("prefers Japanese kana even when Han characters are also present", () => {
			// Mixed kanji + hiragana resolves to Japanese even though Han text is present.
			expect(detectLocaleFromText("今日はいい天気ですね")).toBe("ja");
		});

		it("is case-insensitive for hint words", () => {
			expect(detectLocaleFromText("HOLA GRACIAS")).toBe("es");
			expect(detectLocaleFromText("Bonjour MERCI")).toBe("fr");
		});

		it("picks the language with more hint-word hits when both appear", () => {
			expect(detectLocaleFromText("hola gracias mais")).toBe("es");
			expect(detectLocaleFromText("hola merci oui")).toBe("fr");
		});

		it("abstains on a tied hint-word score", () => {
			expect(detectLocaleFromText("hola merci")).toBeNull();
		});

		it("abstains when a diacritic is scored by both languages", () => {
			// é signals both Spanish and French, so it cannot decide and the
			// heuristic abstains rather than guess.
			expect(detectLocaleFromText("café")).toBeNull();
		});

		it("decides via a diacritic unique to one language", () => {
			// ñ uniquely signals Spanish; œ uniquely signals French.
			expect(detectLocaleFromText("el niño")).toBe("es");
			expect(detectLocaleFromText("cœur")).toBe("fr");
		});

		it("lets a unique diacritic break a one-hint-word tie", () => {
			// Tied hint words: the Spanish-only ¿ breaks the tie.
			expect(detectLocaleFromText("hola mais ¿")).toBe("es");
		});
	});

	describe("resolveOwnerLocale", () => {
		it("trims a whitespace-padded owner locale before accepting it", () => {
			expect(
				resolveOwnerLocale({ ownerLocale: "  ja  ", recentMessage: "hola" }),
			).toBe("ja");
		});

		it("ignores a whitespace-only owner locale", () => {
			expect(
				resolveOwnerLocale({
					ownerLocale: "   ",
					recentMessage: "こんにちは",
				}),
			).toBe("ja");
		});

		it("defaults to en when the provided default is whitespace-only", () => {
			expect(
				resolveOwnerLocale({
					recentMessage: "plain words",
					defaultLocale: "  ",
				}),
			).toBe("en");
		});

		it("trims a padded valid default before returning it", () => {
			expect(
				resolveOwnerLocale({
					recentMessage: "plain words",
					defaultLocale: "  fr  ",
				}),
			).toBe("fr");
		});
	});
});
