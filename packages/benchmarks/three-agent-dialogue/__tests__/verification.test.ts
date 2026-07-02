/**
 * Unit tests for the honest verification module (#9310 §3.11).
 *
 * The old verification scored synthetic runs identically to real ones:
 * transcripts were counted from the ground-truth prompt (a tautology),
 * emotion was keyword-matched against the ground-truth prompt, and the
 * gt-fallback ASR made every synthetic turn look transcribed. These tests
 * pin the honest semantics: only real TTS + real ASR turns are scored.
 */

import { describe, expect, it } from "vitest";
import {
  computeVerification,
  detectEmotionFromText,
  type TurnOutcome,
} from "../runner/verification.ts";

const THRESHOLDS = {
  minNonEmptyTranscripts: 1,
  minAudioDurationSec: 1.0,
  minDistinctSpeakers: 3,
  emotionDetectedMinFraction: 0.8,
};

function turn(over: Partial<TurnOutcome> & { turnIdx: number }): TurnOutcome {
  return {
    speaker: "alice",
    gtText: "I am excited to talk about this wonderful idea.",
    asrText: null,
    ttsReal: false,
    asrReal: false,
    detectedEmotion: null,
    expectedEmotion: "joy",
    ...over,
  };
}

function realTurn(turnIdx: number, speaker: string): TurnOutcome {
  const asrText = "I'm excited to explore this wonderful question together.";
  return turn({
    turnIdx,
    speaker,
    asrText,
    ttsReal: true,
    asrReal: true,
    detectedEmotion: detectEmotionFromText(asrText),
  });
}

describe("computeVerification", () => {
  it("scores an all-real run and passes when thresholds are met", () => {
    const result = computeVerification({
      turns: [realTurn(0, "alice"), realTurn(1, "bob"), realTurn(2, "cleo")],
      thresholds: THRESHOLDS,
      mixDurationSec: 5,
      mixNonBlank: true,
      distinctSpeakers: 3,
      smokeRequested: false,
    });
    expect(result.mode).toBe("real");
    expect(result.scored).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.transcriptNotNull).toBe(true);
    expect(result.emotionDetectedFraction).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("a real run with broken ASR fails the transcript check", () => {
    const broken = [
      realTurn(0, "alice"),
      realTurn(1, "bob"),
      realTurn(2, "cleo"),
    ].map((t) => ({ ...t, asrText: null, asrReal: false }));
    const result = computeVerification({
      turns: broken,
      thresholds: THRESHOLDS,
      mixDurationSec: 5,
      mixNonBlank: true,
      distinctSpeakers: 3,
      smokeRequested: false,
    });
    // No real ASR at all → the run is not scoreable and must fail.
    expect(result.scored).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("demotes any synthetic turn to synthetic-smoke and skips scored checks", () => {
    const result = computeVerification({
      turns: [
        realTurn(0, "alice"),
        turn({ turnIdx: 1, speaker: "bob" }), // synthetic
        realTurn(2, "cleo"),
      ],
      thresholds: THRESHOLDS,
      mixDurationSec: 5,
      mixNonBlank: true,
      distinctSpeakers: 3,
      smokeRequested: true,
    });
    expect(result.mode).toBe("synthetic-smoke");
    expect(result.scored).toBe(false);
    expect(result.realTurns).toBe(2);
    expect(result.syntheticTurns).toBe(1);
    expect(result.skippedChecks.length).toBeGreaterThan(0);
    // Smoke was requested and structural checks hold → structural pass.
    expect(result.pass).toBe(true);
  });

  it("a FULL synthetic run fails with an explicit not-scored failure", () => {
    const result = computeVerification({
      turns: [
        turn({ turnIdx: 0 }),
        turn({ turnIdx: 1, speaker: "bob" }),
        turn({ turnIdx: 2, speaker: "cleo" }),
      ],
      thresholds: THRESHOLDS,
      mixDurationSec: 5,
      mixNonBlank: true,
      distinctSpeakers: 3,
      smokeRequested: false,
    });
    expect(result.scored).toBe(false);
    expect(result.pass).toBe(false);
    expect(
      result.failures.some((f) => f.includes("synthetic TTS/ASR path")),
    ).toBe(true);
    // Ground-truth text must earn no transcript/emotion credit.
    expect(result.transcriptNotNull).toBe(false);
    expect(result.emotionDetectedFraction).toBe(0);
  });

  it("structural failures fail even a requested smoke run", () => {
    const result = computeVerification({
      turns: [turn({ turnIdx: 0 })],
      thresholds: THRESHOLDS,
      mixDurationSec: 0.2,
      mixNonBlank: false,
      distinctSpeakers: 1,
      smokeRequested: true,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });
});
