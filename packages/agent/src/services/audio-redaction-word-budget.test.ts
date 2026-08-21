/**
 * Isolated, dependency-free proof of the audio-redaction timed-word budget.
 * Origin used `pool.findIndex` to unique sentinels (quadratic). This file
 * imports the production helper only — no runtime, media store, or mocks.
 */

import { describe, expect, it } from "bun:test";
import {
  AudioRedactionWordBudgetError,
  assertAudioRedactionInputBudget,
  assertAudioRedactionWordBudget,
  MAX_AUDIO_REDACTION_MATCH_CANDIDATES,
  MAX_AUDIO_REDACTION_NORMALIZED_CHARS,
  MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS,
  MAX_AUDIO_REDACTION_PII_SPAN_CHARS,
  MAX_AUDIO_REDACTION_PII_SPANS,
  MAX_AUDIO_REDACTION_RAW_CHARS,
  MAX_AUDIO_REDACTION_WORD_CHARS,
  MAX_AUDIO_REDACTION_WORDS,
  selectAudioRedactionSentinels,
} from "./audio-redaction-word-budget.ts";

describe("selectAudioRedactionSentinels", () => {
  it("selects distributed non-PII sentinels", () => {
    expect(
      selectAudioRedactionSentinels(
        [
          { text: "alpha", startMs: 0, endMs: 100 },
          { text: "secret", startMs: 200, endMs: 300 },
          { text: "middle", startMs: 400, endMs: 500 },
          { text: "omega", startMs: 800, endMs: 900 },
        ],
        [{ startMs: 150, endMs: 350 }],
      ),
    ).toEqual(["alpha", "middle", "omega"]);
  });

  it("keeps first-occurrence uniqueness on a hostile unique-token stream", () => {
    const words = Array.from({ length: 40_000 }, (_, index) => ({
      text: `tok${index}`,
      startMs: index * 10,
      endMs: index * 10 + 5,
    }));
    const started = performance.now();
    expect(selectAudioRedactionSentinels(words, [])).toEqual([
      "tok0",
      "tok19999",
      "tok39999",
    ]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("sweeps a hostile word-by-span product without a quadratic scan", () => {
    const words = Array.from({ length: 20_000 }, (_, index) => ({
      text: `tok${index}`,
      startMs: index * 10,
      endMs: index * 10 + 5,
    }));
    const spans = Array.from({ length: 20_000 }, (_, index) => ({
      startMs: 1_000_000 + index * 10,
      endMs: 1_000_005 + index * 10,
    })).reverse();
    const started = performance.now();
    expect(selectAudioRedactionSentinels(words, spans)).toEqual([
      "tok0",
      "tok9999",
      "tok19999",
    ]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("preserves midpoint ordering with unsorted words and spans", () => {
    expect(
      selectAudioRedactionSentinels(
        [
          { text: "omega", startMs: 800, endMs: 900 },
          { text: "secret-two", startMs: 500, endMs: 550 },
          { text: "alpha", startMs: 0, endMs: 100 },
          { text: "middle", startMs: 400, endMs: 450 },
          { text: "secret-one", startMs: 200, endMs: 250 },
        ],
        [
          { startMs: 490, endMs: 560 },
          { startMs: 190, endMs: 260 },
        ],
      ),
    ).toEqual(["alpha", "middle", "omega"]);
  });

  it("fails closed on an oversized timed-word stream", () => {
    const words = Array.from(
      { length: MAX_AUDIO_REDACTION_WORDS + 1 },
      (_, index) => ({
        text: "hi",
        startMs: index,
        endMs: index + 1,
      }),
    );
    try {
      selectAudioRedactionSentinels(words, []);
      throw new Error("expected AUDIO_REDACTION_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioRedactionWordBudgetError);
      expect((error as AudioRedactionWordBudgetError).code).toBe(
        "AUDIO_REDACTION_UNBOUNDED",
      );
      expect((error as Error).message).toMatch(/exceeds 100000 words/);
    }
  });

  it("fails closed on an oversized timed-word token", () => {
    try {
      selectAudioRedactionSentinels(
        [
          {
            text: "a".repeat(MAX_AUDIO_REDACTION_WORD_CHARS + 1),
            startMs: 0,
            endMs: 10,
          },
        ],
        [],
      );
      throw new Error("expected AUDIO_REDACTION_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioRedactionWordBudgetError);
      expect((error as AudioRedactionWordBudgetError).code).toBe(
        "AUDIO_REDACTION_UNBOUNDED",
      );
      expect((error as Error).message).toMatch(/exceeds 4096 characters/);
    }
  });

  it("fails closed before allocating an oversized normalized word stream", () => {
    const words = Array.from(
      {
        length:
          Math.floor(
            MAX_AUDIO_REDACTION_NORMALIZED_CHARS /
              MAX_AUDIO_REDACTION_WORD_CHARS,
          ) + 1,
      },
      (_, index) => ({
        text: "a".repeat(MAX_AUDIO_REDACTION_WORD_CHARS),
        startMs: index,
        endMs: index + 1,
      }),
    );
    expect(() => selectAudioRedactionSentinels(words, [])).toThrow(
      /normalized timed-word stream exceeds/,
    );
  });

  it("fails closed on aggregate raw punctuation before normalization", () => {
    const words = Array.from(
      {
        length:
          Math.floor(
            MAX_AUDIO_REDACTION_RAW_CHARS / MAX_AUDIO_REDACTION_WORD_CHARS,
          ) + 1,
      },
      (_, index) => ({
        text: "!".repeat(MAX_AUDIO_REDACTION_WORD_CHARS),
        startMs: index,
        endMs: index + 1,
      }),
    );
    try {
      assertAudioRedactionWordBudget(words);
      throw new Error("expected AUDIO_REDACTION_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioRedactionWordBudgetError);
      expect((error as AudioRedactionWordBudgetError).code).toBe(
        "AUDIO_REDACTION_UNBOUNDED",
      );
      expect((error as Error).message).toMatch(/raw timed-word stream exceeds/);
      expect((error as AudioRedactionWordBudgetError).context).toEqual({
        rawChars: words.length * MAX_AUDIO_REDACTION_WORD_CHARS,
        maxRawChars: MAX_AUDIO_REDACTION_RAW_CHARS,
      });
    }
    expect(() => assertAudioRedactionInputBudget(words, [])).toThrow(
      /raw timed-word stream exceeds/,
    );
  });

  it("fails closed on excessive PII count and aggregate PII text", () => {
    const words = [{ text: "ordinary", startMs: 0, endMs: 1 }];
    expect(() =>
      assertAudioRedactionInputBudget(
        words,
        Array.from({ length: MAX_AUDIO_REDACTION_PII_SPANS + 1 }, () => ({
          text: "secret",
        })),
      ),
    ).toThrow(/PII stream exceeds/);
    expect(() =>
      assertAudioRedactionInputBudget(
        words,
        Array.from(
          {
            length:
              Math.floor(
                MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS /
                  MAX_AUDIO_REDACTION_PII_SPAN_CHARS,
              ) + 1,
          },
          () => ({ text: "x".repeat(MAX_AUDIO_REDACTION_PII_SPAN_CHARS) }),
        ),
      ),
    ).toThrow(/normalized PII stream exceeds/);
    expect(() =>
      assertAudioRedactionInputBudget(words, [
        { text: "x".repeat(MAX_AUDIO_REDACTION_PII_SPAN_CHARS + 1) },
      ]),
    ).toThrow(/PII text exceeds/);
  });

  it("fails closed before repeated needles can allocate unbounded matches", () => {
    const words = Array.from(
      { length: MAX_AUDIO_REDACTION_MATCH_CANDIDATES },
      (_, index) => ({ text: "a", startMs: index, endMs: index + 1 }),
    );
    expect(() =>
      assertAudioRedactionInputBudget(words, [{ text: "a" }, { text: "a" }]),
    ).toThrow(/matcher exceeds/);
  });

  it("fails closed on an oversized sentinel span plan", () => {
    expect(() =>
      selectAudioRedactionSentinels(
        [{ text: "ordinary", startMs: 0, endMs: 1 }],
        Array.from(
          { length: MAX_AUDIO_REDACTION_MATCH_CANDIDATES + 1 },
          (_, index) => ({ startMs: index + 2, endMs: index + 3 }),
        ),
      ),
    ).toThrow(/plan exceeds/);
  });
});
