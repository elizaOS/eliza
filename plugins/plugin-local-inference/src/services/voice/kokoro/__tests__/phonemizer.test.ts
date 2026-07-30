/** Covers Kokoro's desktop and mobile phonemizer selection and pronunciation data paths. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	CmuEnglishPhonemizer,
	FallbackG2PPhonemizer,
	KOKORO_PAD_ID,
	kokoroLangToPhonemizerLanguage,
	NpmPhonemizePhonemizer,
	resolvePhonemizer,
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

describe("CmuEnglishPhonemizer", () => {
	it("loads the staged Android dictionary as data instead of compiling the package object", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "eliza-cmudict-"));
		const dictionaryPath = path.join(directory, "cmudict.tsv");
		await writeFile(
			dictionaryPath,
			"speed\tS P IY1 D\ntest\tT EH1 S T\n",
			"utf8",
		);
		const previous = process.env.ELIZA_CMU_DICTIONARY_PATH;
		process.env.ELIZA_CMU_DICTIONARY_PATH = dictionaryPath;
		try {
			const seq = await new CmuEnglishPhonemizer().phonemize(
				"Speed test.",
				"en-us",
			);
			expect(seq.phonemes).toBe("spˈid tˈɛst.");
		} finally {
			if (previous === undefined) {
				delete process.env.ELIZA_CMU_DICTIONARY_PATH;
			} else {
				process.env.ELIZA_CMU_DICTIONARY_PATH = previous;
			}
			await rm(directory, { recursive: true });
		}
	});

	it("maps dictionary pronunciations, stress, punctuation, and numbers to Kokoro IPA", async () => {
		const seq = await new CmuEnglishPhonemizer().phonemize(
			"Hello, world 31.",
			"a",
		);

		expect(seq.phonemes).toContain("h");
		expect(seq.phonemes).toContain("w");
		expect(seq.phonemes).toContain("ˈ");
		expect(seq.phonemes).toContain(",");
		expect(seq.phonemes).toContain(".");
		expect(seq.phonemes).not.toContain("31");
		expect(seq.ids[0]).toBe(KOKORO_PAD_ID);
		expect(seq.ids.at(-1)).toBe(KOKORO_PAD_ID);
	});

	it("loads CMUdict once and keeps warm phonemization below the mobile hot-path budget", async () => {
		const phonemizer = new CmuEnglishPhonemizer();
		await phonemizer.phonemize("Prime the dictionary.", "en-us");
		const startedAt = performance.now();
		await phonemizer.phonemize(
			"This second request uses the already parsed dictionary.",
			"en-us",
		);
		expect(performance.now() - startedAt).toBeLessThan(25);
	});

	it("rejects unsupported languages instead of fabricating English output", async () => {
		await expect(
			new CmuEnglishPhonemizer().phonemize("bonjour", "fr"),
		).rejects.toThrow(/only supports American English/);
	});

	it("is selected for the Android bionic-host path without initializing espeak WASM", async () => {
		const previous = process.env.ELIZA_BIONIC_HOST_DELEGATED;
		process.env.ELIZA_BIONIC_HOST_DELEGATED = "1";
		try {
			await expect(resolvePhonemizer()).resolves.toBeInstanceOf(
				CmuEnglishPhonemizer,
			);
		} finally {
			if (previous === undefined) {
				delete process.env.ELIZA_BIONIC_HOST_DELEGATED;
			} else {
				process.env.ELIZA_BIONIC_HOST_DELEGATED = previous;
			}
		}
	});
});
