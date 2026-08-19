/**
 * Isolated, dependency-free proof of the audio-redaction timed-word budget.
 * Origin used `pool.findIndex` to unique sentinels (quadratic). This file
 * imports the production helper only — no runtime, media store, or mocks.
 */

import { describe, expect, it } from "bun:test";
import {
  AudioRedactionWordBudgetError,
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
});
