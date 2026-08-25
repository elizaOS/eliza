import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkTokens, PhraseChunker } from "./phrase-chunker";

type Clock = () => number;

function makeClock() {
	let now = 0;
	const clock: Clock = () => now;
	return { clock, set: (v: number) => (now = v) };
}

describe("PhraseChunker punctuation boundaries", () => {
	it("flushes on a sentence/clause terminator", () => {
		const chunker = new PhraseChunker({});
		const phrase = chunker.push({ text: "Hello,", index: 0, acceptedAt: 0 });
		expect(phrase).not.toBeNull();
		expect(phrase?.text).toBe("Hello,");
		expect(phrase?.terminator).toBe("punctuation");
		expect(phrase?.fromIndex).toBe(0);
		expect(phrase?.toIndex).toBe(0);
	});

	it("flushes on each of the default terminator set", () => {
		for (const mark of [",", ".", "!", "?", ";", ":"]) {
			const chunker = new PhraseChunker({});
			const phrase = chunker.push({
				text: `word${mark}`,
				index: 0,
				acceptedAt: 0,
			});
			expect(phrase?.terminator).toBe("punctuation");
		}
	});

	it("does not flush on a token that does not end with a terminator", () => {
		const chunker = new PhraseChunker({});
		expect(chunker.push({ text: "hello", index: 0, acceptedAt: 0 })).toBeNull();
		expect(chunker.push({ text: "world", index: 1, acceptedAt: 0 })).toBeNull();
	});

	it("respects a custom terminator set", () => {
		const chunker = new PhraseChunker({ sentenceTerminators: new Set(["؟"]) });
		expect(chunker.push({ text: "ok.", index: 0, acceptedAt: 0 })).toBeNull();
		const phrase = chunker.push({ text: "ok؟", index: 1, acceptedAt: 0 });
		expect(phrase?.terminator).toBe("punctuation");
	});
});

describe("PhraseChunker max-token cap", () => {
	it("force-flushes at the configured cap with terminator max-cap", () => {
		const chunker = new PhraseChunker({ maxTokensPerPhrase: 3 });
		expect(chunker.push({ text: "a", index: 0, acceptedAt: 0 })).toBeNull();
		expect(chunker.push({ text: "b", index: 1, acceptedAt: 0 })).toBeNull();
		const phrase = chunker.push({ text: "c", index: 2, acceptedAt: 0 });
		expect(phrase?.text).toBe("abc");
		expect(phrase?.terminator).toBe("max-cap");
		expect(phrase?.fromIndex).toBe(0);
		expect(phrase?.toIndex).toBe(2);
	});
});

describe("PhraseChunker phoneme-stream mode", () => {
	const fakeTokenizer = {
		tokenize: (text: string) => Array.from({ length: text.length }),
	};

	it("throws when phoneme-stream mode has no tokenizer", () => {
		expect(() => new PhraseChunker({ chunkOn: "phoneme-stream" })).toThrow();
	});

	it("flushes every phonemesPerChunk phonemes", () => {
		const chunker = new PhraseChunker(
			{ chunkOn: "phoneme-stream", phonemesPerChunk: 4 },
			fakeTokenizer as never,
		);
		expect(chunker.push({ text: "a", index: 0, acceptedAt: 0 })).toBeNull();
		expect(chunker.push({ text: "a", index: 1, acceptedAt: 0 })).toBeNull();
		expect(chunker.push({ text: "a", index: 2, acceptedAt: 0 })).toBeNull();
		const phrase = chunker.push({ text: "a", index: 3, acceptedAt: 0 });
		expect(phrase?.text).toBe("aaaa");
		expect(phrase?.terminator).toBe("phoneme-stream");
	});
});

describe("PhraseChunker time-budget flush (injected clock)", () => {
	it("flushes via flushIfTimeBudgetExceeded once the budget elapses", () => {
		const { clock, set } = makeClock();
		const chunker = new PhraseChunker(
			{ maxAccumulationMs: 700, firstPhraseMaxAccumulationMs: 700 },
			null,
			clock,
		);
		chunker.push({ text: "hello", index: 0, acceptedAt: 0 });
		set(699);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		set(700);
		const phrase = chunker.flushIfTimeBudgetExceeded();
		expect(phrase?.text).toBe("hello");
		expect(phrase?.terminator).toBe("max-cap");
	});

	it("applies the shorter first-phrase budget then the full budget", () => {
		const { clock, set } = makeClock();
		const chunker = new PhraseChunker({ maxAccumulationMs: 700 }, null, clock);
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		set(349);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		set(350);
		const first = chunker.flushIfTimeBudgetExceeded();
		expect(first?.text).toBe("a");

		chunker.push({ text: "b", index: 1, acceptedAt: 0 });
		set(351);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		set(1050);
		expect(chunker.flushIfTimeBudgetExceeded()?.text).toBe("b");
	});

	it("disables the time budget when maxAccumulationMs is 0", () => {
		const { clock, set } = makeClock();
		const chunker = new PhraseChunker({ maxAccumulationMs: 0 }, null, clock);
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		set(100_000);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		expect(chunker.msUntilTimeBudget()).toBe(Number.POSITIVE_INFINITY);
	});

	it("reports ms until budget via msUntilTimeBudget", () => {
		const { clock, set } = makeClock();
		const chunker = new PhraseChunker(
			{ maxAccumulationMs: 700, firstPhraseMaxAccumulationMs: 700 },
			null,
			clock,
		);
		expect(chunker.msUntilTimeBudget()).toBe(Number.POSITIVE_INFINITY);
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		set(300);
		expect(chunker.msUntilTimeBudget()).toBe(400);
		set(700);
		expect(chunker.msUntilTimeBudget()).toBe(0);
	});
});

describe("PhraseChunker rollback (dropPendingFrom)", () => {
	it("drops buffered tokens at or after fromIndex and recounts phonemes", () => {
		const { clock, set } = makeClock();
		const tokenizer = { tokenize: (text: string) => text.length };
		const chunker = new PhraseChunker(
			{ chunkOn: "phoneme-stream", phonemesPerChunk: 100 },
			tokenizer as never,
			clock,
		);
		for (let i = 0; i < 5; i += 1) {
			chunker.push({ text: "ab", index: i, acceptedAt: 0 });
		}
		chunker.dropPendingFrom(3);
		const phrase = chunker.flushPending();
		expect(phrase?.text).toBe("ababab");
		expect(phrase?.fromIndex).toBe(0);
		expect(phrase?.toIndex).toBe(2);
	});

	it("is a no-op when nothing is dropped", () => {
		const chunker = new PhraseChunker({});
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		chunker.dropPendingFrom(1);
		expect(chunker.flushPending()?.text).toBe("a");
	});
});

describe("chunkTokens static helper", () => {
	it("cuts phrases at punctuation and flushes the tail", () => {
		const phrases = chunkTokens(
			[
				{ text: "Hello", index: 0 },
				{ text: " there", index: 1 },
				{ text: ".", index: 2 },
				{ text: "Next", index: 3 },
			],
			{},
		);
		expect(phrases).toHaveLength(2);
		expect(phrases[0].text).toBe("Hello there.");
		expect(phrases[0].terminator).toBe("punctuation");
		expect(phrases[1].text).toBe("Next");
		expect(phrases[1].terminator).toBe("max-cap");
	});

	it("respects maxTokensPerPhrase", () => {
		const phrases = chunkTokens(
			[
				{ text: "a", index: 0 },
				{ text: "b", index: 1 },
				{ text: "c", index: 2 },
			],
			{ maxTokensPerPhrase: 2 },
		);
		expect(phrases).toHaveLength(2);
		expect(phrases[0].text).toBe("ab");
		expect(phrases[1].text).toBe("c");
	});
});

describe("ELIZA_PHRASE_FLUSH_MS env parsing (strict numeric)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	async function fresh() {
		return await import("./phrase-chunker");
	}

	it("falls back to 700 for scientific-notation garbage instead of a 1ms budget", async () => {
		// "1e3" parses to 1 via parseInt — a near-instant budget that
		// fragments every phrase into word-sized chunks.
		vi.stubEnv("ELIZA_PHRASE_FLUSH_MS", "1e3");
		const { PhraseChunker: FreshChunker } = await fresh();
		const { clock, set } = makeClock();
		const chunker = new FreshChunker(
			{ firstPhraseMaxAccumulationMs: 700 },
			null,
			clock,
		);
		chunker.push({ text: "hello", index: 0, acceptedAt: 0 });
		set(699);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		set(700);
		expect(chunker.flushIfTimeBudgetExceeded()?.terminator).toBe("max-cap");
	});

	it("falls back to 700 for suffix-mixed garbage", async () => {
		vi.stubEnv("ELIZA_PHRASE_FLUSH_MS", "700ms");
		const { PhraseChunker: FreshChunker } = await fresh();
		const { clock, set } = makeClock();
		const chunker = new FreshChunker(
			{ firstPhraseMaxAccumulationMs: 700 },
			null,
			clock,
		);
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		set(699);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		set(700);
		expect(chunker.flushIfTimeBudgetExceeded()?.terminator).toBe("max-cap");
	});

	it("accepts a valid decimal value", async () => {
		vi.stubEnv("ELIZA_PHRASE_FLUSH_MS", "1500");
		const { PhraseChunker: FreshChunker } = await fresh();
		const { clock, set } = makeClock();
		const chunker = new FreshChunker(
			{ firstPhraseMaxAccumulationMs: 1500 },
			null,
			clock,
		);
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		set(1499);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		set(1500);
		expect(chunker.flushIfTimeBudgetExceeded()?.terminator).toBe("max-cap");
	});
});

describe("ELIZA_PHRASE_FLUSH_FIRST_MS env parsing (strict numeric)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	async function fresh() {
		return await import("./phrase-chunker");
	}

	it("falls back to the default first-phrase budget for scientific notation", async () => {
		// "1e3" parses to 1 — first audio would flush after 1ms, fragmenting
		// the opening of every reply.
		vi.stubEnv("ELIZA_PHRASE_FLUSH_FIRST_MS", "1e3");
		const { PhraseChunker: FreshChunker } = await fresh();
		const { clock, set } = makeClock();
		const chunker = new FreshChunker({ maxAccumulationMs: 700 }, null, clock);
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		set(2);
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		set(350);
		expect(chunker.flushIfTimeBudgetExceeded()?.terminator).toBe("max-cap");
	});

	it("honors a valid override capped at the full budget", async () => {
		vi.stubEnv("ELIZA_PHRASE_FLUSH_FIRST_MS", "500");
		const { PhraseChunker: FreshChunker } = await fresh();
		const { clock, set } = makeClock();
		const chunker = new FreshChunker({ maxAccumulationMs: 400 }, null, clock);
		chunker.push({ text: "a", index: 0, acceptedAt: 0 });
		set(400);
		expect(chunker.flushIfTimeBudgetExceeded()?.terminator).toBe("max-cap");
	});
});
