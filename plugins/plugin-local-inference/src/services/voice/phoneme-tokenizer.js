/**
 * Phoneme tokenizer interface used by the IPA-mode phrase chunker.
 *
 * The chunker consumes a stream of accepted text tokens and re-emits them
 * as sub-phrase chunks at phoneme boundaries. This lets TTS start
 * synthesizing partial phrases ~250ms earlier than the punctuation-only
 * mode, at the cost of slightly less prosody coherence per chunk.
 *
 * WAVE-7 DEPENDENCY:
 *   The production tokenizer is an out-of-scope dependency. Candidates
 *   evaluated in the architecture review:
 *     - espeak-ng (C, FFI bridge, best coverage, GPL-3)
 *     - phonemizer.js (pure JS port of espeak, MIT, slower)
 *     - ipa-translate-rs (Rust, NAPI, fast, smaller language coverage)
 *   The shipping decision lives in inference/AGENTS.md §6.4.
 *
 *   Until then, callers MUST pass `CharacterPhonemeStub` explicitly and
 *   accept that the resulting chunk boundaries are character-aligned, not
 *   phoneme-aligned. The stub logs a warning the first time it is used.
 */
let stubWarned = false;
/**
 * Placeholder phoneme tokenizer that emits one phoneme per input character.
 * Whitespace characters are skipped. This is NOT a real IPA tokenizer and
 * the produced chunk boundaries are character boundaries, not phoneme
 * boundaries. Suitable only for end-to-end wiring tests until a real
 * tokenizer ships in Wave-7.
 */
export class CharacterPhonemeStub {
	name = "CharacterPhonemeStub";
	isStub = true;
	tokenize(text, sourceTokenIndex) {
		if (!stubWarned) {
			stubWarned = true;
			// Loud, one-shot. Production must NOT see this warning.
			// Emitted via console.warn per the task contract.
			// eslint-disable-next-line no-console
			console.warn(
				"[CharacterPhonemeStub] Using placeholder phoneme tokenizer — chunk boundaries are character boundaries, not IPA phonemes. Replace with a real tokenizer (espeak-ng / phonemizer.js / ipa-translate-rs) before production. See inference/AGENTS.md §6.4.",
			);
		}
		const out = [];
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (/\s/.test(ch)) continue;
			out.push({ ipa: ch, sourceTokenIndex });
		}
		return out;
	}
}
/** Reset the one-shot warn latch — test-only. */
export function _resetStubWarnLatchForTests() {
	stubWarned = false;
}
//# sourceMappingURL=phoneme-tokenizer.js.map
