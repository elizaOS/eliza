import { describe, expect, it } from "vitest";

import {
	FallbackG2PPhonemizer,
	KOKORO_PAD_ID,
	kokoroLangToPhonemizerLanguage,
	NpmPhonemizePhonemizer,
} from "../phonemizer";

describe("FallbackG2PPhonemizer", () => {
	it("uses Kokoro tokenizer boundary ids and IPA for common smoke phrases", async () => {
		const seq = await new FallbackG2PPhonemizer().phonemize(
			"Hello there.",
			"a",
		);

		expect(seq.phonemes).toBe("hɛloʊ ðɛɹ.");
		expect(Array.from(seq.ids)).toEqual([
			KOKORO_PAD_ID,
			50,
			86,
			54,
			57,
			135,
			16,
			81,
			86,
			123,
			4,
			KOKORO_PAD_ID,
		]);
	});

	it("maps Kokoro voice language ids to phonemizer locales", () => {
		expect(kokoroLangToPhonemizerLanguage("a")).toBe("en-us");
		expect(kokoroLangToPhonemizerLanguage("b")).toBe("en-gb");
		expect(kokoroLangToPhonemizerLanguage("en-us")).toBe("en-us");
	});

	it("loads the bundled phonemizer package before falling back to pseudo phonemes", async () => {
		const phonemizer = await NpmPhonemizePhonemizer.tryLoad();
		expect(phonemizer?.id).toBe("phonemizer");
		if (!phonemizer) {
			throw new Error("phonemizer package did not load");
		}

		const seq = await phonemizer.phonemize("Hello there.", "a");

		expect(seq.phonemes).not.toBe("hɛloʊ ðɛɹ.");
		expect(seq.phonemes).toContain("h");
		expect(Array.from(seq.ids)).toContain(156);
	});
});
