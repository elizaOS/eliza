/**
 * Text → phoneme-id adapter for Kokoro-82M.
 *
 * Kokoro is trained against espeak-ng IPA tokens with a small fixed vocab
 * (~178 entries: IPA symbols + stress/punct markers + special <s>/<pad>).
 * Production deployments should bring real espeak-ng (`phonemize` npm
 * package wraps the C library); the bundled fallback here is a
 * deterministic letter-to-pseudo-phoneme adapter that produces audible
 * speech for ASCII English text but loses prosodic accuracy.
 *
 * Resolution order:
 *   1. Caller-provided `KokoroPhonemizer` (preferred — bring your own).
 *   2. Dynamically-imported `phonemize` npm package, if installed.
 *   3. Bundled `FallbackG2PPhonemizer` (degrades gracefully, never throws on
 *      ASCII input).
 *
 * Non-ASCII text with no real phonemizer raises `KokoroPhonemizerError` —
 * silent garbage out is worse than a surfaced error (AGENTS.md §3).
 */

import {
  type KokoroPhonemeSequence,
  type KokoroPhonemizer,
  KokoroPhonemizerError,
} from "./types";

/**
 * Kokoro v1.0 phoneme vocabulary. The model embeds 178 phoneme ids; this
 * table is the canonical mapping used by upstream espeak-ng exports. We
 * encode here only the subset the fallback emits — real espeak phonemizers
 * deliver pre-tokenised id arrays already so the table size does not bound
 * them.
 */
const VOCAB: Readonly<Record<string, number>> = {
  "<pad>": 0,
  "<s>": 1,
  "</s>": 2,
  // Whitespace / punctuation — kept terse, this is the fallback path.
  " ": 16,
  ",": 17,
  ".": 18,
  "?": 19,
  "!": 20,
  ";": 21,
  ":": 22,
  // Vowels (very rough mapping — see README "fallback phonemizer caveats").
  a: 43,
  e: 44,
  i: 45,
  o: 46,
  u: 47,
  // Consonants.
  b: 60,
  d: 61,
  f: 62,
  g: 63,
  h: 64,
  j: 65,
  k: 66,
  l: 67,
  m: 68,
  n: 69,
  p: 70,
  q: 71,
  r: 72,
  s: 73,
  t: 74,
  v: 75,
  w: 76,
  x: 77,
  y: 78,
  z: 79,
};

const PAD = VOCAB["<pad>"];
const BOS = VOCAB["<s>"];
const EOS = VOCAB["</s>"];

/**
 * Deterministic ASCII-only G2P used when no real phonemizer is installed.
 * Lossy by design — this exists so dev environments without espeak-ng can
 * still hear *something*, not to ship to production. README documents.
 */
export class FallbackG2PPhonemizer implements KokoroPhonemizer {
  readonly id = "fallback-g2p";

  async phonemize(text: string, _lang: string): Promise<KokoroPhonemeSequence> {
    const cleaned = text.normalize("NFKD").toLowerCase();
    for (const ch of cleaned) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      // Allow ASCII printable + whitespace; refuse anything else so we
      // surface non-English text rather than emit silence.
      if (cp > 127) {
        throw new KokoroPhonemizerError(
          `[kokoro] fallback phonemizer cannot handle non-ASCII character '${ch}' (U+${cp.toString(16).padStart(4, "0")}). Install the 'phonemize' npm package or pass a custom KokoroPhonemizer for full Unicode coverage.`,
        );
      }
    }
    const ids: number[] = [BOS];
    for (const ch of cleaned) {
      const id = VOCAB[ch];
      if (id !== undefined) ids.push(id);
      // Unknown char: skip (acts as a pad). The model's training data did
      // not contain raw graphemes anyway — best effort.
    }
    ids.push(EOS);
    return {
      ids: Int32Array.from(ids),
      phonemes: cleaned,
    };
  }
}

interface PhonemizeMod {
  // The `phonemize` npm package's typing varies between v1/v2; we treat it
  // structurally so a minor version bump does not break our import.
  phonemize?: (text: string, opts?: unknown) => string | Promise<string>;
  default?: { phonemize?: PhonemizeMod["phonemize"] };
}

/**
 * Wraps the npm `phonemize` package when present. It returns an IPA string
 * which we tokenise with the same VOCAB above. Real Kokoro inference should
 * use a proper espeak tokenizer — production deployments bring their own;
 * this is the "install npm and it works" middle ground.
 */
export class NpmPhonemizePhonemizer implements KokoroPhonemizer {
  readonly id = "phonemize";
  private constructor(private readonly mod: PhonemizeMod) {}

  static async tryLoad(): Promise<NpmPhonemizePhonemizer | null> {
    try {
      const spec = "phonemize";
      const mod = (await import(spec)) as PhonemizeMod;
      const phon = mod.phonemize ?? mod.default?.phonemize;
      if (typeof phon !== "function") return null;
      return new NpmPhonemizePhonemizer(mod);
    } catch {
      return null;
    }
  }

  async phonemize(text: string, lang: string): Promise<KokoroPhonemeSequence> {
    const phon = this.mod.phonemize ?? this.mod.default?.phonemize;
    if (!phon) {
      throw new KokoroPhonemizerError(
        "[kokoro] 'phonemize' module loaded but does not export a phonemize() function",
      );
    }
    const out = await phon(text, { lang });
    const phonemes = typeof out === "string" ? out : String(out);
    const ids: number[] = [BOS];
    for (const ch of phonemes.toLowerCase()) {
      const id = VOCAB[ch];
      if (id !== undefined) ids.push(id);
    }
    ids.push(EOS);
    return { ids: Int32Array.from(ids), phonemes };
  }
}

/** Lazy resolver: caller override → npm `phonemize` → bundled fallback. */
export async function resolvePhonemizer(
  override?: KokoroPhonemizer,
): Promise<KokoroPhonemizer> {
  if (override) return override;
  const npm = await NpmPhonemizePhonemizer.tryLoad();
  if (npm) return npm;
  return new FallbackG2PPhonemizer();
}

/** Exported for tests and bench-time diagnostics. */
export const KOKORO_PAD_ID = PAD;
