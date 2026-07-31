/**
 * Text → phoneme-id adapter for Kokoro-82M.
 *
 * Kokoro is trained against espeak-ng IPA tokens with a small fixed vocab
 * (~178 entries: IPA symbols + stress/punctuation markers). Desktop runtimes
 * use the eSpeak-backed npm phonemizer. Mobile runtimes use a cached CMU
 * pronunciation dictionary because eSpeak's WASM bootstrap takes tens of
 * seconds under Android's embedded musl Bun process; the bionic Kokoro host
 * consumes the resulting IPA directly.
 *
 * Resolution order:
 *   1. Caller-provided `KokoroPhonemizer` (preferred — bring your own).
 *   2. CMUdict for Android/iOS US-English speech.
 *   3. Dynamically-imported `phonemizer`/`phonemize` on desktop.
 *   4. Bundled `FallbackG2PPhonemizer` (degrades gracefully, never throws on
 *      ASCII input).
 *
 * Non-ASCII text with no real phonemizer raises `KokoroPhonemizerError` —
 * silent garbage out is worse than a surfaced error (AGENTS.md §3).
 */

import { readAliasedEnv } from "@elizaos/shared";
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

const ARPABET_TO_IPA: Readonly<Record<string, string>> = {
	AA: "ɑ",
	AE: "æ",
	AH: "ʌ",
	AO: "ɔ",
	AW: "aʊ",
	AY: "aɪ",
	B: "b",
	CH: "ʧ",
	D: "d",
	DH: "ð",
	EH: "ɛ",
	ER: "ɜɹ",
	EY: "eɪ",
	F: "f",
	G: "ɡ",
	HH: "h",
	IH: "ɪ",
	IY: "i",
	JH: "ʤ",
	K: "k",
	L: "l",
	M: "m",
	N: "n",
	NG: "ŋ",
	OW: "oʊ",
	OY: "ɔɪ",
	P: "p",
	R: "ɹ",
	S: "s",
	SH: "ʃ",
	T: "t",
	TH: "θ",
	UH: "ʊ",
	UW: "u",
	V: "v",
	W: "w",
	Y: "j",
	Z: "z",
	ZH: "ʒ",
};

const SMALL_NUMBER_WORDS = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
] as const;
const TENS_NUMBER_WORDS = [
	"",
	"",
	"twenty",
	"thirty",
	"forty",
	"fifty",
	"sixty",
	"seventy",
	"eighty",
	"ninety",
] as const;
const NUMBER_SCALES = [
	[1_000_000_000, "billion"],
	[1_000_000, "million"],
	[1_000, "thousand"],
] as const;

function integerToEnglish(value: number): string {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new KokoroPhonemizerError(
			`[kokoro] CMU phonemizer cannot expand numeric value ${value}`,
		);
	}
	if (value < 20) return SMALL_NUMBER_WORDS[value];
	if (value < 100) {
		const tens = TENS_NUMBER_WORDS[Math.floor(value / 10)];
		const remainder = value % 10;
		return remainder === 0 ? tens : `${tens} ${SMALL_NUMBER_WORDS[remainder]}`;
	}
	if (value < 1_000) {
		const remainder = value % 100;
		const hundreds = `${SMALL_NUMBER_WORDS[Math.floor(value / 100)]} hundred`;
		return remainder === 0
			? hundreds
			: `${hundreds} ${integerToEnglish(remainder)}`;
	}
	for (const [scale, label] of NUMBER_SCALES) {
		if (value >= scale) {
			const remainder = value % scale;
			const prefix = `${integerToEnglish(Math.floor(value / scale))} ${label}`;
			return remainder === 0
				? prefix
				: `${prefix} ${integerToEnglish(remainder)}`;
		}
	}
	throw new KokoroPhonemizerError(
		`[kokoro] CMU phonemizer cannot expand numeric value ${value}`,
	);
}

function numberTokenToEnglish(token: string): string {
	const normalized = token.replace(/,/g, "");
	const [integerPart, decimalPart] = normalized.split(".");
	const integer = Number(integerPart);
	const integerWords = integerToEnglish(integer);
	if (decimalPart === undefined || decimalPart.length === 0) {
		return integerWords;
	}
	return `${integerWords} point ${[...decimalPart]
		.map((digit) => SMALL_NUMBER_WORDS[Number(digit)])
		.join(" ")}`;
}

function arpabetPronunciationToIpa(pronunciation: string): string {
	return pronunciation
		.split(/\s+/)
		.map((phone) => {
			const match = /^([A-Z]+)([012])?$/.exec(phone);
			if (!match) return "";
			const base = match[1];
			const stress = match[2];
			let ipa = ARPABET_TO_IPA[base] ?? "";
			if (base === "AH" && stress === "0") ipa = "ə";
			if (base === "ER" && stress === "0") ipa = "ɚ";
			if (!ipa) return "";
			return `${stress === "1" ? "ˈ" : stress === "2" ? "ˌ" : ""}${ipa}`;
		})
		.join("");
}

function ipaToSequence(phonemes: string): KokoroPhonemeSequence {
	const ids: number[] = [BOS];
	for (const ch of phonemes) {
		const id = VOCAB[ch];
		if (id !== undefined) ids.push(id);
	}
	ids.push(EOS);
	return { ids: Int32Array.from(ids), phonemes };
}

interface CmuDictionaryModule {
	dictionary: Readonly<Record<string, string>>;
}

let cmuDictionaryPromise: Promise<Readonly<Record<string, string>>> | null =
	null;
let cmuDictionarySource: string | null = null;

async function loadStagedCmuDictionary(
	dictionaryPath: string,
): Promise<Readonly<Record<string, string>>> {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(dictionaryPath, "utf8");
	const dictionary: Record<string, string> = Object.create(null);
	let lineStart = 0;
	while (lineStart < source.length) {
		let lineEnd = source.indexOf("\n", lineStart);
		if (lineEnd < 0) lineEnd = source.length;
		const separator = source.indexOf("\t", lineStart);
		if (separator > lineStart && separator < lineEnd) {
			dictionary[source.slice(lineStart, separator)] = source.slice(
				separator + 1,
				lineEnd,
			);
		}
		lineStart = lineEnd + 1;
	}
	return dictionary;
}

function loadCmuDictionary(): Promise<Readonly<Record<string, string>>> {
	const stagedPath = process.env.ELIZA_CMU_DICTIONARY_PATH?.trim();
	const source = stagedPath || "module";
	if (!cmuDictionaryPromise || cmuDictionarySource !== source) {
		cmuDictionarySource = source;
		cmuDictionaryPromise = stagedPath
			? loadStagedCmuDictionary(stagedPath)
			: import("cmu-pronouncing-dictionary").then(
					(module: CmuDictionaryModule) => module.dictionary,
				);
	}
	return cmuDictionaryPromise;
}

/**
 * Fast mobile English phonemizer backed by CMUdict. Android's musl Bun process
 * can spend tens of seconds initializing the bundled espeak WASM image; this
 * dictionary is parsed once, retained for the process lifetime, and maps its
 * ARPABET entries into the exact IPA vocabulary Kokoro consumes. Unknown words
 * use the deterministic local G2P rules, keeping the hot path offline and
 * bounded without pretending unsupported languages are valid English.
 */
export class CmuEnglishPhonemizer implements KokoroPhonemizer {
	readonly id = "cmudict";

	async phonemize(text: string, lang: string): Promise<KokoroPhonemeSequence> {
		if (!/^a$|^en(?:-us)?$/i.test(lang.trim())) {
			throw new KokoroPhonemizerError(
				`[kokoro] CMU phonemizer only supports American English; received ${JSON.stringify(lang)}`,
			);
		}
		const dictionary = await loadCmuDictionary();
		const normalized = text.normalize("NFKC").toLowerCase();
		const phonemes = normalized.replace(
			/[a-z]+(?:'[a-z]+)*|\d+(?:,\d{3})*(?:\.\d+)?|[^a-z\d]+/g,
			(token) => {
				if (/^\d/.test(token)) {
					return numberTokenToEnglish(token)
						.split(/\s+/)
						.map(
							(word) =>
								arpabetPronunciationToIpa(dictionary[word] ?? "") ||
								fallbackWordToIpa(word),
						)
						.join(" ");
				}
				if (/^[a-z]/.test(token)) {
					return (
						arpabetPronunciationToIpa(dictionary[token] ?? "") ||
						fallbackWordToIpa(token)
					);
				}
				return token;
			},
		);
		return ipaToSequence(phonemes);
	}
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
					`[kokoro] fallback phonemizer cannot handle non-ASCII character '${ch}' (U+${cp.toString(16).padStart(4, "0")}). Install the 'phonemizer' npm package or pass a custom KokoroPhonemizer for full Unicode coverage.`,
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
	// The `phonemizer` / legacy `phonemize` npm package typing varies between
	// packages and versions; treat it structurally so minor updates do not break
	// mobile TTS.
	phonemize?: (
		text: string,
		langOrOpts?: unknown,
	) => string | string[] | Promise<string | string[]>;
	default?: { phonemize?: PhonemizeMod["phonemize"] };
}

/**
 * Wraps the npm `phonemizer` package when present. It returns an IPA string
 * which we tokenise with the same VOCAB above. Real Kokoro inference should
 * use a proper espeak tokenizer — production deployments bring their own;
 * this is the "install npm and it works" middle ground.
 */
export class NpmPhonemizePhonemizer implements KokoroPhonemizer {
	readonly id: string;
	private constructor(
		private readonly mod: PhonemizeMod,
		id = "phonemizer",
		private readonly callStyle: "language" | "options" = "language",
	) {
		this.id = id;
	}

	static async tryLoad(): Promise<NpmPhonemizePhonemizer | null> {
		try {
			const mod = (await import("phonemizer")) as PhonemizeMod;
			const phon = mod.phonemize ?? mod.default?.phonemize;
			if (typeof phon !== "function") return null;
			return new NpmPhonemizePhonemizer(mod);
		} catch {
			// Older local installs used a package named `phonemize`. Keep it as a
			// secondary, deliberately non-bundled fallback for developer machines.
		}
		try {
			const spec = "phonemize";
			const mod = (await import(/* @vite-ignore */ spec)) as PhonemizeMod;
			const phon = mod.phonemize ?? mod.default?.phonemize;
			if (typeof phon !== "function") return null;
			return new NpmPhonemizePhonemizer(mod, "phonemize", "options");
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
		const out = await phon(
			text,
			this.callStyle === "language"
				? kokoroLangToPhonemizerLanguage(lang)
				: { lang },
		);
		const phonemes = Array.isArray(out)
			? out.join(" ")
			: typeof out === "string"
				? out
				: String(out);
		const ids: number[] = [BOS];
		for (const ch of phonemes.toLowerCase()) {
			const id = VOCAB[ch];
			if (id !== undefined) ids.push(id);
		}
		ids.push(EOS);
		return { ids: Int32Array.from(ids), phonemes };
	}
}

export function kokoroLangToPhonemizerLanguage(lang: string): string {
	switch (lang.trim().toLowerCase()) {
		case "a":
			return "en-us";
		case "b":
			return "en-gb";
		default:
			return lang || "en-us";
	}
}

/** Lazy resolver: caller override → mobile CMUdict → espeak WASM → fallback. */
export async function resolvePhonemizer(
	override?: KokoroPhonemizer,
): Promise<KokoroPhonemizer> {
	if (override) return override;
	if (
		process.env.ELIZA_BIONIC_HOST_DELEGATED?.trim() === "1" ||
		["android", "ios"].includes(
			readAliasedEnv("ELIZA_PLATFORM")?.trim().toLowerCase() ?? "",
		)
	) {
		return new CmuEnglishPhonemizer();
	}
	const npm = await NpmPhonemizePhonemizer.tryLoad();
	if (npm) return npm;
	return new FallbackG2PPhonemizer();
}

/** Exported for tests and bench-time diagnostics. */
export const KOKORO_PAD_ID = PAD;
