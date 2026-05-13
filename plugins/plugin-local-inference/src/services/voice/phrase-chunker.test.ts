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
      { maxAccumulationMs: 200, maxTokensPerPhrase: 100 },
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
      { maxAccumulationMs: 200, maxTokensPerPhrase: 100 },
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
      { maxAccumulationMs: 200, maxTokensPerPhrase: 100 },
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
      { maxAccumulationMs: 200, maxTokensPerPhrase: 100 },
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
