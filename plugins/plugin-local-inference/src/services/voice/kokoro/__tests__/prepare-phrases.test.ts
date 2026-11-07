/**
 * The native Kokoro graph caps wrapped input at 510 symbols (two pads), so
 * an IPA string may hold at most 508 codepoints. See
 * `routes/local-inference-tts-route.ts`, which already enforces 508 for the
 * phonemize-only path.
 */
import { describe, expect, it } from "vitest";
import { prepareKokoroPhrases } from "../prepare-phrases";
import type { KokoroPhonemizer } from "../types";

/** Echoes the input text as its IPA, so IPA length equals text length. */
const echoPhonemizer: KokoroPhonemizer = {
	id: "test-echo",
	async phonemize(text: string) {
		return {
			ids: Int32Array.from([0, 1, 0]),
			phonemes: text,
		};
	},
};

function twoWordText(total: number): string {
	const left = Math.floor((total - 1) / 2);
	const right = total - 1 - left;
	return `${"a".repeat(left)} ${"a".repeat(right)}`;
}

describe("prepareKokoroPhrases 508-codepoint boundary", () => {
	it("keeps a 508-codepoint phrase whole", async () => {
		const text = twoWordText(508);
		const phrases = await prepareKokoroPhrases(text, "a", echoPhonemizer);
		expect(phrases).toHaveLength(1);
		expect(phrases[0]?.text).toBe(text);
	});

	it("splits a 509-codepoint phrase (508 IPA + 2 pads = 510 wrapped)", async () => {
		const text = twoWordText(509);
		const phrases = await prepareKokoroPhrases(text, "a", echoPhonemizer);
		expect(phrases.length).toBeGreaterThan(1);
		expect(phrases.map((phrase) => phrase.text).join("")).toBe(text);
		for (const phrase of phrases) {
			expect(Array.from(phrase.phonemes.phonemes).length).toBeLessThanOrEqual(
				508,
			);
		}
	});

	it("splits a 510-codepoint phrase", async () => {
		const text = twoWordText(510);
		const phrases = await prepareKokoroPhrases(text, "a", echoPhonemizer);
		expect(phrases.length).toBeGreaterThan(1);
		expect(phrases.map((phrase) => phrase.text).join("")).toBe(text);
		for (const phrase of phrases) {
			expect(Array.from(phrase.phonemes.phonemes).length).toBeLessThanOrEqual(
				508,
			);
		}
	});

	it("rejects an indivisible 509-codepoint word", async () => {
		await expect(
			prepareKokoroPhrases("a".repeat(509), "a", echoPhonemizer),
		).rejects.toMatchObject({ code: "KOKORO_PHRASE_TOO_LARGE" });
	});
});
