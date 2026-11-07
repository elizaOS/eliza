/**
 * The real `phonemizer` package (eSpeak NG) splits text into clauses and drops
 * the punctuation between them. Kokoro has tokens for those marks and reads
 * them as pauses and question intonation, so the adapter puts them back.
 */
import { phonemize } from "phonemizer";
import { describe, expect, it } from "vitest";
import { NpmPhonemizePhonemizer } from "../phonemizer";

async function loadPhonemizer(): Promise<NpmPhonemizePhonemizer> {
	const phonemizer = await NpmPhonemizePhonemizer.tryLoad();
	if (!phonemizer) throw new Error("the phonemizer package did not load");
	return phonemizer;
}

describe("NpmPhonemizePhonemizer clause punctuation", () => {
	it("keeps the commas, question marks and periods between clauses", async () => {
		const phonemizer = await loadPhonemizer();
		const text = "Hello there, how are you? Fine.";
		const out = await phonemizer.phonemize(text, "a");
		expect(out.phonemes).toBe("həlˈoʊ ðˈɛɹ, hˈaʊ ɑːɹ juː? fˈaɪn.");
		// Kokoro ids: "," = 3, "." = 4, "!" = 5, "?" = 6.
		expect(Array.from(out.ids).filter((id) => id >= 3 && id <= 6)).toEqual([
			3, 6, 4,
		]);
	});

	it("leaves eSpeak's words and clause boundaries as they were", async () => {
		const phonemizer = await loadPhonemizer();
		// eSpeak reads past "p.m." because a lowercase word follows.
		const text = "Call me at 5 p.m. tomorrow, please. Wait... really?!";
		const out = await phonemizer.phonemize(text, "a");
		expect(out.phonemes).toBe(
			"kˈɔːl mˌiː æt fˈaɪv pˌiːˈɛm təmˈɑːɹoʊ, plˈiːz. wˈeɪt... ɹˈiəli?!",
		);
		const clauses = await phonemize(text, "en-us");
		expect(out.phonemes.replace(/[,.!?]/gu, "")).toBe(clauses.join(" "));
	});

	it("falls back to the bare clauses when it cannot tell which mark ends each one", async () => {
		const phonemizer = await loadPhonemizer();
		// The period inside the quote ends a clause for eSpeak but is not
		// followed by whitespace, so the clause and mark counts differ.
		const text = 'He said "hi." Then left.';
		const out = await phonemizer.phonemize(text, "a");
		expect(out.phonemes).toBe((await phonemize(text, "en-us")).join(" "));
	});
});
