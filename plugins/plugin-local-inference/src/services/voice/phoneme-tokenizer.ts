/**
 * Phoneme tokenizer interface used by the IPA-mode phrase chunker.
 *
 * The chunker consumes a stream of accepted text tokens and re-emits them
 * as sub-phrase chunks at phoneme boundaries. This lets TTS start
 * synthesizing partial phrases earlier than the punctuation-only mode, at
 * the cost of slightly less prosody coherence per chunk.
 *
 * The default tokenizer is synchronous because the chunker runs in the
 * accepted-token hot path. Full espeak-ng / phonemizer integrations can
 * implement this interface by resolving their native or package dependency
 * before constructing the scheduler.
 */

export interface Phoneme {
	/** IPA symbol(s) for this phoneme. */
	ipa: string;
	/** Index of the source `TextToken` this phoneme came from. Used by the
	 *  chunker to map sub-phrases back to token-index ranges so that the
	 *  rollback queue can still drop the right audio on a verifier reject. */
	sourceTokenIndex: number;
}

export interface PhonemeTokenizer {
	/** Stable tokenizer name, used for logging and cache keys. */
	readonly name: string;
	/** Relative quality signal for telemetry and debugging. */
	readonly quality: "ipa" | "approximate";
	/**
	 * Tokenize a single text token's text into phonemes. The chunker calls
	 * this once per accepted token; the tokenizer returns the phonemes for
	 * that token only. Returning an empty array is legal (e.g. whitespace
	 * tokens) and is treated as "no phoneme boundary added by this token".
	 */
	tokenize(text: string, sourceTokenIndex: number): readonly Phoneme[];
}

const WORD_IPA: Readonly<Record<string, readonly string[]>> = {
	a: ["ə"],
	an: ["æ", "n"],
	and: ["æ", "n", "d"],
	are: ["ɑː", "r"],
	be: ["b", "iː"],
	eliza: ["ə", "l", "iː", "z", "ə"],
	hello: ["h", "ə", "l", "oʊ"],
	is: ["ɪ", "z"],
	of: ["ʌ", "v"],
	the: ["ð", "ə"],
	to: ["t", "uː"],
	world: ["w", "ɜː", "r", "l", "d"],
};

const DIGRAPH_IPA: Readonly<Record<string, string>> = {
	ch: "tʃ",
	ck: "k",
	ng: "ŋ",
	ph: "f",
	qu: "kʷ",
	sh: "ʃ",
	th: "θ",
	wh: "w",
};

const LETTER_IPA: Readonly<Record<string, string>> = {
	a: "æ",
	b: "b",
	c: "k",
	d: "d",
	e: "ɛ",
	f: "f",
	g: "ɡ",
	h: "h",
	i: "ɪ",
	j: "dʒ",
	k: "k",
	l: "l",
	m: "m",
	n: "n",
	o: "ɑ",
	p: "p",
	q: "k",
	r: "r",
	s: "s",
	t: "t",
	u: "ʌ",
	v: "v",
	w: "w",
	x: "k",
	y: "j",
	z: "z",
};

const DIGIT_IPA: Readonly<Record<string, readonly string[]>> = {
	"0": ["z", "iː", "r", "oʊ"],
	"1": ["w", "ʌ", "n"],
	"2": ["t", "uː"],
	"3": ["θ", "r", "iː"],
	"4": ["f", "ɔː", "r"],
	"5": ["f", "aɪ", "v"],
	"6": ["s", "ɪ", "k", "s"],
	"7": ["s", "ɛ", "v", "ə", "n"],
	"8": ["eɪ", "t"],
	"9": ["n", "aɪ", "n"],
};

function ipaForWord(word: string): readonly string[] {
	const known = WORD_IPA[word];
	if (known) return known;

	const out: string[] = [];
	for (let i = 0; i < word.length; ) {
		const pair = word.slice(i, i + 2);
		const digraph = DIGRAPH_IPA[pair];
		if (digraph) {
			out.push(digraph);
			i += 2;
			continue;
		}

		const mapped = LETTER_IPA[word[i]];
		if (mapped) out.push(mapped);
		i += 1;
	}
	return out;
}

/**
 * Synchronous English IPA approximation for phrase chunking.
 *
 * This is not a pronunciation dictionary; it is a deterministic tokenizer
 * whose output is close enough for boundary counting and rollback range
 * mapping. Deployments that need accent-accurate phonemization can inject a
 * higher-quality `PhonemeTokenizer` built around espeak-ng or phonemizer.
 */
export class RuleBasedEnglishPhonemeTokenizer implements PhonemeTokenizer {
	readonly name = "RuleBasedEnglishPhonemeTokenizer";
	readonly quality = "approximate" as const;

	tokenize(text: string, sourceTokenIndex: number): readonly Phoneme[] {
		const out: Phoneme[] = [];
		const pieces = text.match(/[A-Za-z]+|\d/g) ?? [];

		for (const piece of pieces) {
			const phonemes = /^\d$/.test(piece)
				? (DIGIT_IPA[piece] ?? [])
				: ipaForWord(piece.toLowerCase());
			for (const ipa of phonemes) {
				out.push({ ipa, sourceTokenIndex });
			}
		}

		return out;
	}
}

export function createDefaultPhonemeTokenizer(): PhonemeTokenizer {
	return new RuleBasedEnglishPhonemeTokenizer();
}
