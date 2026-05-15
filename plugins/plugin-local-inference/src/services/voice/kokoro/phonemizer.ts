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
 * Kokoro v1.0 phoneme vocabulary. These ids must match the bundled
 * `tts/kokoro/tokenizer.json` asset. The boundary token is `$` (id 0);
 * feeding invented `<s>` / `</s>` ids shifts the whole utterance and produces
 * plausible-sounding but lexically wrong audio.
 */
const VOCAB: Readonly<Record<string, number>> = {
	$: 0,
	";": 1,
	":": 2,
	",": 3,
	".": 4,
	"!": 5,
	"?": 6,
	"—": 9,
	"…": 10,
	'"': 11,
	"(": 12,
	")": 13,
	"“": 14,
	"”": 15,
	" ": 16,
	"̃": 17,
	ʣ: 18,
	ʥ: 19,
	ʦ: 20,
	ʨ: 21,
	ᵝ: 22,
	ꭧ: 23,
	A: 24,
	I: 25,
	O: 31,
	Q: 33,
	S: 35,
	T: 36,
	W: 39,
	Y: 41,
	ᵊ: 42,
	a: 43,
	b: 44,
	c: 45,
	d: 46,
	e: 47,
	f: 48,
	h: 50,
	i: 51,
	j: 52,
	k: 53,
	l: 54,
	m: 55,
	n: 56,
	o: 57,
	p: 58,
	q: 59,
	r: 60,
	s: 61,
	t: 62,
	u: 63,
	v: 64,
	w: 65,
	x: 66,
	y: 67,
	z: 68,
	ɑ: 69,
	ɐ: 70,
	ɒ: 71,
	æ: 72,
	β: 75,
	ɔ: 76,
	ɕ: 77,
	ç: 78,
	ɖ: 80,
	ð: 81,
	ʤ: 82,
	ə: 83,
	ɚ: 85,
	ɛ: 86,
	ɜ: 87,
	ɟ: 90,
	ɡ: 92,
	ɥ: 99,
	ɨ: 101,
	ɪ: 102,
	ʝ: 103,
	ɯ: 110,
	ɰ: 111,
	ŋ: 112,
	ɳ: 113,
	ɲ: 114,
	ɴ: 115,
	ø: 116,
	ɸ: 118,
	θ: 119,
	œ: 120,
	ɹ: 123,
	ɾ: 125,
	ɻ: 126,
	ʁ: 128,
	ɽ: 129,
	ʂ: 130,
	ʃ: 131,
	ʈ: 132,
	ʧ: 133,
	ʊ: 135,
	ʋ: 136,
	ʌ: 138,
	ɣ: 139,
	ɤ: 140,
	χ: 142,
	ʎ: 143,
	ʒ: 147,
	ʔ: 148,
	ˈ: 156,
	ˌ: 157,
	ː: 158,
	ʰ: 162,
	ʲ: 164,
	"↓": 169,
	"→": 171,
	"↗": 172,
	"↘": 173,
	ᵻ: 177,
};

const PAD = VOCAB.$;
const BOS = VOCAB.$;
const EOS = VOCAB.$;

const FALLBACK_WORD_IPA: Readonly<Record<string, string>> = {
	a: "ə",
	am: "æm",
	and: "ænd",
	are: "ɑɹ",
	cal: "kæl",
	capital: "kæpɪtəl",
	can: "kæn",
	france: "fɹæns",
	hello: "hɛloʊ",
	hear: "hiɹ",
	is: "ɪz",
	me: "mi",
	meeting: "mitɪŋ",
	of: "ʌv",
	the: "ðə",
	there: "ðɛɹ",
	to: "tu",
	you: "ju",
};

const FALLBACK_DIGRAPH_IPA: Readonly<Record<string, string>> = {
	ch: "ʧ",
	ng: "ŋ",
	sh: "ʃ",
	th: "θ",
	wh: "w",
	zh: "ʒ",
};

function fallbackWordToIpa(word: string): string {
	const known = FALLBACK_WORD_IPA[word];
	if (known) return known;
	let out = "";
	for (let i = 0; i < word.length; i += 1) {
		const pair = word.slice(i, i + 2);
		const digraph = FALLBACK_DIGRAPH_IPA[pair];
		if (digraph) {
			out += digraph;
			i += 1;
			continue;
		}
		out += word[i];
	}
	return out;
}

function fallbackTextToIpa(cleaned: string): string {
	return cleaned.replace(/[a-z]+|[^a-z]+/g, (part) =>
		/^[a-z]+$/.test(part) ? fallbackWordToIpa(part) : part,
	);
}

/**
 * Deterministic ASCII-only G2P used when no real phonemizer is installed.
 * Lossy by design — this exists so dev environments without espeak-ng still
 * produce lexically useful smoke output for common English phrases, not to
 * replace a production Misaki/espeak phonemizer.
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
		const phonemes = fallbackTextToIpa(cleaned);
		const ids: number[] = [BOS];
		for (const ch of phonemes) {
			const id = VOCAB[ch];
			if (id !== undefined) ids.push(id);
			// Unknown char: skip (acts as a pad). The model's training data did
			// not contain raw graphemes anyway — best effort.
		}
		ids.push(EOS);
		return {
			ids: Int32Array.from(ids),
			phonemes,
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
