/**
 * Preflights complete Kokoro utterances against the native 510-phoneme boundary.
 * Word-boundary splitting preserves the ordered text exactly; an indivisible
 * oversized word fails before any phrase is dispatched to synthesis.
 */
import { ElizaError } from "@elizaos/core";
import type { KokoroPhonemeSequence, KokoroPhonemizer } from "./types";

export interface PreparedKokoroPhrase {
	text: string;
	phonemes: KokoroPhonemeSequence;
}

export async function prepareKokoroPhrases(
	text: string,
	lang: string,
	phonemizer: KokoroPhonemizer,
): Promise<PreparedKokoroPhrase[]> {
	const phonemes = await phonemizer.phonemize(text, lang);
	// Each native IPA codepoint contributes at most one token. Counting every
	// codepoint is conservative even when the native vocabulary ignores it.
	if (Array.from(phonemes.phonemes).length <= 510) {
		return [{ text, phonemes }];
	}
	const words = text.match(/\S+\s*|\s+/gu) ?? [];
	if (words.length < 2) {
		throw new ElizaError(
			"[Kokoro] A word exceeds the speech model context. Add a word boundary before retrying.",
			{
				code: "KOKORO_PHRASE_TOO_LARGE",
				context: {
					phonemeCount: Array.from(phonemes.phonemes).length,
					maximum: 510,
				},
			},
		);
	}
	const midpoint = Math.floor(words.length / 2);
	const left = words.slice(0, midpoint).join("");
	const right = words.slice(midpoint).join("");
	return [
		...(await prepareKokoroPhrases(left, lang, phonemizer)),
		...(await prepareKokoroPhrases(right, lang, phonemizer)),
	];
}
