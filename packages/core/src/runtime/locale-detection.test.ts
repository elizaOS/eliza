/**
 * Unit tests for the owner-locale resolver (`detectLocaleFromText`,
 * `resolveOwnerLocale`). Deterministic in-line literals — no runtime, model,
 * or database: every expectation below was observed from the real module.
 */
import { describe, expect, it } from "vitest";
import {
	detectLocaleFromText,
	resolveOwnerLocale,
} from "./locale-detection.ts";

describe("detectLocaleFromText", () => {
	it("returns null for non-string input", () => {
		expect(detectLocaleFromText(undefined)).toBeNull();
		expect(detectLocaleFromText(null)).toBeNull();
	});

	it("returns null for empty and whitespace-only text", () => {
		expect(detectLocaleFromText("")).toBeNull();
		expect(detectLocaleFromText("   \n\t  ")).toBeNull();
	});

	it("detects Japanese from kana", () => {
		expect(detectLocaleFromText("こんにちは")).toBe("ja");
	});

	it("prefers kana over Han characters when both scripts appear", () => {
		expect(detectLocaleFromText("こんにちは世界")).toBe("ja");
	});

	it("detects zh-Hans from Han characters without kana", () => {
		expect(detectLocaleFromText("你好世界")).toBe("zh-Hans");
	});

	it("detects Spanish from hint words alone", () => {
		expect(detectLocaleFromText("hola gracias por favor")).toBe("es");
	});

	it("matches hint words case-insensitively", () => {
		expect(detectLocaleFromText("HOLA GRACIAS")).toBe("es");
	});

	it("keeps hyphenated tokens whole so compound hints match", () => {
		expect(detectLocaleFromText("Rappelle-moi demain matin")).toBe("fr");
	});

	it("detects French from hint words and diacritics together", () => {
		expect(detectLocaleFromText("bonjour merci très demain")).toBe("fr");
	});

	it("scores a Spanish-only diacritic as es", () => {
		expect(detectLocaleFromText("señor mañana")).toBe("es");
	});

	it("abstains on a shared diacritic tie (é scores both es and fr)", () => {
		expect(detectLocaleFromText("café")).toBeNull();
	});

	it("abstains when hint-word scores tie", () => {
		expect(detectLocaleFromText("hola merci")).toBeNull();
	});

	it("returns null when there is no signal at all", () => {
		expect(detectLocaleFromText("hello world how are you")).toBeNull();
	});
});

describe("resolveOwnerLocale", () => {
	it("prefers a non-empty ownerLocale over detection and default", () => {
		expect(
			resolveOwnerLocale({
				ownerLocale: "fr",
				recentMessage: "こんにちは",
				defaultLocale: "es",
			}),
		).toBe("fr");
	});

	it("trims surrounding whitespace from ownerLocale", () => {
		expect(resolveOwnerLocale({ ownerLocale: "  ja  " })).toBe("ja");
	});

	it("treats a whitespace-only ownerLocale as absent and falls through to detection", () => {
		expect(
			resolveOwnerLocale({ ownerLocale: "   ", recentMessage: "bonjour" }),
		).toBe("fr");
	});

	it("falls through to detection on empty or null ownerLocale", () => {
		expect(resolveOwnerLocale({ ownerLocale: "", recentMessage: "hola" })).toBe(
			"es",
		);
		expect(
			resolveOwnerLocale({ ownerLocale: null, recentMessage: "你好" }),
		).toBe("zh-Hans");
	});

	it("uses defaultLocale when detection has no signal", () => {
		expect(
			resolveOwnerLocale({
				recentMessage: "hello world",
				defaultLocale: "pt-BR",
			}),
		).toBe("pt-BR");
	});

	it("passes an arbitrary caller default through untouched", () => {
		expect(resolveOwnerLocale({ defaultLocale: "xx-Latn" })).toBe("xx-Latn");
	});

	it("falls back to en when defaultLocale is missing, empty, or whitespace", () => {
		expect(resolveOwnerLocale({})).toBe("en");
		expect(resolveOwnerLocale({ defaultLocale: "" })).toBe("en");
		expect(resolveOwnerLocale({ defaultLocale: "   " })).toBe("en");
	});
});
