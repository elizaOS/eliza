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

export interface Phoneme {
  /** IPA symbol(s) for this phoneme. With the stub, this is a single
   *  source character — clearly NOT real IPA. */
  ipa: string;
  /** Index of the source `TextToken` this phoneme came from. Used by the
   *  chunker to map sub-phrases back to token-index ranges so that the
   *  rollback queue can still drop the right audio on a verifier reject. */
  sourceTokenIndex: number;
}

export interface PhonemeTokenizer {
  /** Stable tokenizer name, used for logging and cache keys. */
  readonly name: string;
  /** True if this is a placeholder. The IPA chunker logs prominently when
   *  a stub is in use — production must replace it before launch. */
  readonly isStub: boolean;
  /**
   * Tokenize a single text token's text into phonemes. The chunker calls
   * this once per accepted token; the tokenizer returns the phonemes for
   * that token only. Returning an empty array is legal (e.g. whitespace
   * tokens) and is treated as "no phoneme boundary added by this token".
   */
  tokenize(text: string, sourceTokenIndex: number): readonly Phoneme[];
}

let stubWarned = false;

/**
 * Placeholder phoneme tokenizer that emits one phoneme per input character.
 * Whitespace characters are skipped. This is NOT a real IPA tokenizer and
 * the produced chunk boundaries are character boundaries, not phoneme
 * boundaries. Suitable only for end-to-end wiring tests until a real
 * tokenizer ships in Wave-7.
 */
export class CharacterPhonemeStub implements PhonemeTokenizer {
  readonly name = "CharacterPhonemeStub";
  readonly isStub = true;

  tokenize(text: string, sourceTokenIndex: number): readonly Phoneme[] {
    if (!stubWarned) {
      stubWarned = true;
      // Loud, one-shot. Production must NOT see this warning.
      // Emitted via console.warn per the task contract.
      // eslint-disable-next-line no-console
      console.warn(
        "[CharacterPhonemeStub] Using placeholder phoneme tokenizer — chunk boundaries are character boundaries, not IPA phonemes. Replace with a real tokenizer (espeak-ng / phonemizer.js / ipa-translate-rs) before production. See inference/AGENTS.md §6.4.",
      );
    }
    const out: Phoneme[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) continue;
      out.push({ ipa: ch, sourceTokenIndex });
    }
    return out;
  }
}

/** Reset the one-shot warn latch — test-only. */
export function _resetStubWarnLatchForTests(): void {
  stubWarned = false;
}
