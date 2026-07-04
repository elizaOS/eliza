/** Covers `PhraseChunker` punctuation boundaries, time-budget flush, and first-phrase TTFA budget. Deterministic. */
import { describe, expect, it } from "vitest";
import { type ClockMs, chunkTokens, PhraseChunker } from "./phrase-chunker";
import type { TextToken } from "./types";

function tokens(parts: string[]): TextToken[] {
	return parts.map((text, index) => ({ index, text }));
}

describe("PhraseChunker punctuation boundaries", () => {
	it("flushes on semicolon and colon boundaries for faster first audio", () => {
		const phrases = chunkTokens(tokens(["First:", " second;", " third"]), {});

		expect(phrases.map((phrase) => phrase.text)).toEqual([
			"First:",
			" second;",
			" third",
		]);
		expect(phrases.map((phrase) => phrase.terminator)).toEqual([
			"punctuation",
			"punctuation",
			"max-cap",
		]);
	});
});

describe("PhraseChunker T3 time-budget flush", () => {
	it("force-flushes once the time budget elapses on a slow producer", () => {
		let now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			// Pin first-phrase budget == full budget so these mechanism tests
			// exercise the uniform 200ms path (first-phrase shortening is
			// covered separately below).
			{
				maxAccumulationMs: 200,
				firstPhraseMaxAccumulationMs: 200,
				maxTokensPerPhrase: 100,
			},
			null,
			clock,
		);

		expect(chunker.push({ index: 0, text: "hello", acceptedAt: 0 })).toBeNull();
		now = 100;
		expect(
			chunker.push({ index: 1, text: " there", acceptedAt: 0 }),
		).toBeNull();
		now = 220;
		const flushed = chunker.push({ index: 2, text: " friend", acceptedAt: 0 });
		expect(flushed).not.toBeNull();
		expect(flushed?.text).toBe("hello there friend");
		expect(flushed?.terminator).toBe("max-cap");
	});

	it("does not flush before the budget elapses", () => {
		let now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			// Pin first-phrase budget == full budget so these mechanism tests
			// exercise the uniform 200ms path (first-phrase shortening is
			// covered separately below).
			{
				maxAccumulationMs: 200,
				firstPhraseMaxAccumulationMs: 200,
				maxTokensPerPhrase: 100,
			},
			null,
			clock,
		);
		expect(chunker.push({ index: 0, text: "a", acceptedAt: 0 })).toBeNull();
		now = 50;
		expect(chunker.push({ index: 1, text: "b", acceptedAt: 0 })).toBeNull();
		now = 150;
		expect(chunker.push({ index: 2, text: "c", acceptedAt: 0 })).toBeNull();
	});

	it("flushIfTimeBudgetExceeded triggers on caller poll without a new token", () => {
		let now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			// Pin first-phrase budget == full budget so these mechanism tests
			// exercise the uniform 200ms path (first-phrase shortening is
			// covered separately below).
			{
				maxAccumulationMs: 200,
				firstPhraseMaxAccumulationMs: 200,
				maxTokensPerPhrase: 100,
			},
			null,
			clock,
		);
		chunker.push({ index: 0, text: "x", acceptedAt: 0 });
		now = 100;
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		now = 250;
		const phrase = chunker.flushIfTimeBudgetExceeded();
		expect(phrase?.text).toBe("x");
		expect(phrase?.terminator).toBe("max-cap");
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
	});

	it("msUntilTimeBudget reports infinity for an empty buffer or disabled budget", () => {
		let now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			// Pin first-phrase budget == full budget so these mechanism tests
			// exercise the uniform 200ms path (first-phrase shortening is
			// covered separately below).
			{
				maxAccumulationMs: 200,
				firstPhraseMaxAccumulationMs: 200,
				maxTokensPerPhrase: 100,
			},
			null,
			clock,
		);
		expect(chunker.msUntilTimeBudget()).toBe(Number.POSITIVE_INFINITY);
		chunker.push({ index: 0, text: "x", acceptedAt: 0 });
		expect(chunker.msUntilTimeBudget()).toBe(200);
		now = 75;
		expect(chunker.msUntilTimeBudget()).toBe(125);

		const disabled = new PhraseChunker(
			{ maxAccumulationMs: 0, maxTokensPerPhrase: 100 },
			null,
			clock,
		);
		disabled.push({ index: 0, text: "x", acceptedAt: 0 });
		expect(disabled.msUntilTimeBudget()).toBe(Number.POSITIVE_INFINITY);
	});

	it("disabled budget never time-flushes", () => {
		let now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			{ maxAccumulationMs: 0, maxTokensPerPhrase: 100 },
			null,
			clock,
		);
		chunker.push({ index: 0, text: "a", acceptedAt: 0 });
		now = 10_000;
		expect(chunker.push({ index: 1, text: " b", acceptedAt: 0 })).toBeNull();
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
	});
});

describe("PhraseChunker first-phrase budget (TTFA)", () => {
	it("flushes the first phrase on the shorter budget, later phrases on the full one", () => {
		let now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			{
				maxAccumulationMs: 700,
				firstPhraseMaxAccumulationMs: 300,
				maxTokensPerPhrase: 100,
			},
			null,
			clock,
		);
		// First phrase: silent producer, no punctuation — flushes at 300ms.
		expect(chunker.push({ index: 0, text: "hello", acceptedAt: 0 })).toBeNull();
		expect(chunker.msUntilTimeBudget()).toBe(300);
		now = 300;
		const first = chunker.flushIfTimeBudgetExceeded();
		expect(first?.text).toBe("hello");
		expect(first?.terminator).toBe("max-cap");

		// Second phrase now uses the FULL 700ms budget (no fragmentation).
		now = 1000;
		expect(
			chunker.push({ index: 1, text: " there", acceptedAt: 0 }),
		).toBeNull();
		expect(chunker.msUntilTimeBudget()).toBe(700);
		now = 1300; // 300ms in — would have flushed the first phrase, not this one
		expect(chunker.flushIfTimeBudgetExceeded()).toBeNull();
		now = 1700; // full 700ms elapsed
		expect(chunker.flushIfTimeBudgetExceeded()?.text).toBe(" there");
	});

	it("derives the first-phrase budget from maxAccumulationMs when unset (half, capped 350)", () => {
		const now = 0;
		const clock: ClockMs = () => now;
		// 700ms full → first-phrase budget = min(350, 350) = 350.
		const chunker = new PhraseChunker(
			{ maxAccumulationMs: 700, maxTokensPerPhrase: 100 },
			null,
			clock,
		);
		chunker.push({ index: 0, text: "x", acceptedAt: 0 });
		expect(chunker.msUntilTimeBudget()).toBe(350);

		// 400ms full → half = 200 (below the 350 cap).
		const small = new PhraseChunker(
			{ maxAccumulationMs: 400, maxTokensPerPhrase: 100 },
			null,
			clock,
		);
		small.push({ index: 0, text: "x", acceptedAt: 0 });
		expect(small.msUntilTimeBudget()).toBe(200);
	});

	it("resets the first-phrase gate on reset() so each reply gets fast first audio", () => {
		let now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			{
				maxAccumulationMs: 700,
				firstPhraseMaxAccumulationMs: 300,
				maxTokensPerPhrase: 100,
			},
			null,
			clock,
		);
		chunker.push({ index: 0, text: "first", acceptedAt: 0 });
		now = 300;
		expect(chunker.flushIfTimeBudgetExceeded()).not.toBeNull(); // phrase #1 flushed
		chunker.reset();
		now = 1000;
		chunker.push({ index: 0, text: "again", acceptedAt: 0 });
		// Back to the short first-phrase budget after reset.
		expect(chunker.msUntilTimeBudget()).toBe(300);
	});

	it("clamps an explicit first-phrase budget to the full budget", () => {
		const now = 0;
		const clock: ClockMs = () => now;
		const chunker = new PhraseChunker(
			{
				maxAccumulationMs: 200,
				firstPhraseMaxAccumulationMs: 999,
				maxTokensPerPhrase: 100,
			},
			null,
			clock,
		);
		chunker.push({ index: 0, text: "x", acceptedAt: 0 });
		expect(chunker.msUntilTimeBudget()).toBe(200);
	});
});
