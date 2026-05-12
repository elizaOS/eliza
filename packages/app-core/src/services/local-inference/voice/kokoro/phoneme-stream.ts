/**
 * Phoneme streaming for Kokoro-82M.
 *
 * Kokoro consumes a sequence of phoneme ids (espeak-ng IPA tokenised against a
 * small fixed vocab). The scheduler emits phrases at punctuation or
 * `phoneme-stream` boundaries (see `voice/phrase-chunker.ts` `chunkOn`
 * option). This module is the seam between those phrase boundaries and the
 * model's input tensor:
 *
 *   text → phonemizer.phonemize() → KokoroPhonemeSequence (ids) → runtime
 *
 * For maximum responsiveness the runtime can call `streamPhonemes()` against
 * an async text iterator (chunked draft tokens) and forward each window of
 * accumulated ids as soon as a phoneme boundary fires. The default `flushAt`
 * is one phoneme — i.e. emit progress per id — but production deployments
 * lift this to ~8 phonemes to amortise the ONNX forward pass on small
 * windows. This file intentionally has no dependency on the rest of the
 * voice scaffold so it can be reused by the fine-tune evaluator script.
 */

import type {
  KokoroPhonemeSequence,
  KokoroPhonemizer,
} from "./types";

export interface PhonemeStreamWindow {
  /** Cumulative ids since stream start. The runtime can re-tokenise or
   *  carry state by id; the simplest implementation forwards the full
   *  window each call. */
  ids: Int32Array;
  /** Cumulative phoneme string for debugging / display. */
  phonemes: string;
  /** True for the final window in the stream. */
  isFinal: boolean;
}

export interface StreamPhonemesOptions {
  phonemizer: KokoroPhonemizer;
  lang: string;
  /** Emit a window every N new phoneme ids. Default 8 (≈ first audio after a
   *  short syllable cluster — matches the phrase chunker's default cap). */
  flushAt?: number;
}

/**
 * Phonemize an async text source and emit cumulative windows. The caller
 * consumes the iterator with `for await (const window of streamPhonemes(…))`.
 * A pull-style API keeps this independent of the scheduler's event loop —
 * the bench harness and the eval loop both reuse it without taking on a
 * scheduler dependency.
 */
export async function* streamPhonemes(
  textChunks: AsyncIterable<string>,
  opts: StreamPhonemesOptions,
): AsyncIterable<PhonemeStreamWindow> {
  const flushAt = Math.max(1, opts.flushAt ?? 8);
  const idsAcc: number[] = [];
  let phonemesAcc = "";
  let lastFlushAt = 0;
  let leftover = "";

  for await (const chunk of textChunks) {
    if (!chunk) continue;
    leftover += chunk;
    // Only phonemize when we have at least a whole word to feed to the
    // phonemizer — espeak-ng is significantly more accurate when fed
    // word-aligned input. Look back to the last whitespace as the split.
    const split = leftover.lastIndexOf(" ");
    if (split === -1) continue;
    const head = leftover.slice(0, split);
    leftover = leftover.slice(split + 1);
    const seq = await opts.phonemizer.phonemize(head, opts.lang);
    appendSeq(seq, idsAcc);
    phonemesAcc += seq.phonemes;
    if (idsAcc.length - lastFlushAt >= flushAt) {
      lastFlushAt = idsAcc.length;
      yield {
        ids: Int32Array.from(idsAcc),
        phonemes: phonemesAcc,
        isFinal: false,
      };
    }
  }

  if (leftover.length > 0) {
    const seq = await opts.phonemizer.phonemize(leftover, opts.lang);
    appendSeq(seq, idsAcc);
    phonemesAcc += seq.phonemes;
  }
  yield {
    ids: Int32Array.from(idsAcc),
    phonemes: phonemesAcc,
    isFinal: true,
  };
}

function appendSeq(seq: KokoroPhonemeSequence, target: number[]): void {
  // The phonemizer emits a sequence framed with BOS/EOS — strip both when
  // accumulating windows so the model sees one BOS at the head and one EOS
  // at the tail. Defensive against phonemizers that omit framing (the
  // accumulator simply appends raw ids in that case).
  const ids = seq.ids;
  let start = 0;
  let end = ids.length;
  if (ids.length >= 2) {
    // Heuristic: ids ≤ 2 are <pad>/<s>/</s> in the bundled vocab.
    if (ids[0] !== undefined && ids[0] <= 2) start = 1;
    if (ids[end - 1] !== undefined && (ids[end - 1] as number) <= 2) end -= 1;
  }
  for (let i = start; i < end; i++) {
    const id = ids[i];
    if (id !== undefined) target.push(id);
  }
}

/** Synchronous variant for whole-phrase callers (the scheduler dispatches
 *  one phrase at a time in the default `punctuation` mode). Returns the
 *  full id array — equivalent to draining `streamPhonemes` on a single-item
 *  iterator and taking the last window. */
export async function phonemizePhrase(
  text: string,
  opts: StreamPhonemesOptions,
): Promise<PhonemeStreamWindow> {
  const seq = await opts.phonemizer.phonemize(text, opts.lang);
  return { ids: seq.ids, phonemes: seq.phonemes, isFinal: true };
}
