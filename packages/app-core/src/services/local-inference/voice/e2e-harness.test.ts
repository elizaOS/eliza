import { describe, expect, it } from "vitest";
import {
  assertRequiredVoiceArtifacts,
  scoreBargeInInterruption,
  scoreFirstResponseLatency,
  scoreOptimisticRollbackRestart,
  scorePauseContinuation,
  scoreTtsAsrRoundTrip,
  summarizeVoiceE2e,
  VoiceE2eHarnessError,
  wordErrorRate,
} from "./e2e-harness";

describe("voice E2E harness WER scoring", () => {
  it("normalizes punctuation and computes word error rate", () => {
    expect(wordErrorRate("Hello, local voice!", "hello local voice")).toBe(0);
    expect(wordErrorRate("alpha beta gamma", "alpha gamma")).toBeCloseTo(
      1 / 3,
      4,
    );
  });

  it("scores TTS -> ASR roundtrip against a WER threshold", () => {
    const pass = scoreTtsAsrRoundTrip({
      referenceText: "Eliza local voice smoke.",
      hypothesisText: "eliza local voice smoke",
      maxWer: 0,
    });
    expect(pass.passed).toBe(true);
    expect(pass.wer).toBe(0);

    const fail = scoreTtsAsrRoundTrip({
      referenceText: "one two three four",
      hypothesisText: "one four",
      maxWer: 0.25,
    });
    expect(fail.passed).toBe(false);
    expect(fail.wer).toBe(0.5);
  });
});

describe("voice E2E harness artifact validation", () => {
  it("fails clearly when a required model artifact is missing", () => {
    expect(() =>
      assertRequiredVoiceArtifacts(
        [
          { kind: "bundle-root", path: "/models/eliza-1-0_8b.bundle" },
          {
            kind: "asr-model",
            path: "/models/eliza-1-0_8b.bundle/asr/eliza-1-asr.gguf",
            magic: "GGUF",
          },
        ],
        {
          exists: (p) => p.endsWith(".bundle"),
          size: () => null,
          readMagic: () => null,
        },
      ),
    ).toThrow(/asr-model.*not found/);
  });

  it("rejects a tiny or non-GGUF model instead of accepting a placeholder", () => {
    try {
      assertRequiredVoiceArtifacts(
        [
          {
            kind: "tts-model",
            path: "/tmp/placeholder.gguf",
            minBytes: 1024,
            magic: "GGUF",
          },
        ],
        {
          exists: () => true,
          size: () => 12,
          readMagic: () => "NOPE",
        },
      );
      throw new Error("expected artifact validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceE2eHarnessError);
      expect((err as VoiceE2eHarnessError).code).toBe("missing-artifact");
      expect(String((err as Error).message)).toContain("too small");
    }
  });
});

describe("voice E2E harness barge-in scoring", () => {
  it("passes when TTS, LLM, and audio drain cancel inside the budget", () => {
    const result = scoreBargeInInterruption({
      voiceDetectedAtMs: 1000,
      ttsCancelledAtMs: 1060,
      llmCancelledAtMs: 1100,
      audioDrainedAtMs: 1030,
      maxCancelMs: 250,
    });
    expect(result.passed).toBe(true);
    expect(result.bargeInCancelMs).toBe(100);
  });

  it("does not pass a missing LLM cancel measurement by default", () => {
    expect(() =>
      scoreBargeInInterruption({
        voiceDetectedAtMs: 1000,
        ttsCancelledAtMs: 1030,
      }),
    ).toThrow(/llmCancelledAtMs/);
  });
});

describe("voice E2E harness pause and rollback scoring", () => {
  it("scores user continuation within the 4s pause window", () => {
    const result = scorePauseContinuation({
      speechPauseAtMs: 1000,
      speculativeStartedAtMs: 1200,
      continuationAtMs: 4700,
      speculativeAbortedAtMs: 4740,
      finalRestartedAtMs: 4900,
    });
    expect(result.passed).toBe(true);
    expect(result.continuationGapMs).toBe(3700);
  });

  it("fails when the partial response committed before the user continued", () => {
    const result = scorePauseContinuation({
      speechPauseAtMs: 1000,
      continuationAtMs: 3000,
      speculativeStartedAtMs: 1100,
      committedBeforeContinuationAtMs: 2500,
      speculativeAbortedAtMs: 3020,
      finalRestartedAtMs: 3100,
    });
    expect(result.passed).toBe(false);
  });

  it("scores optimistic rollback restore and restart timing", () => {
    const result = scoreOptimisticRollbackRestart({
      speechPauseAtMs: 1000,
      checkpointSavedAtMs: 1025,
      speculativeStartedAtMs: 1030,
      continuationAtMs: 1300,
      speculativeAbortedAtMs: 1315,
      checkpointRestoredAtMs: 1370,
      restartedAtMs: 1460,
    });
    expect(result.passed).toBe(true);
    expect(result.restoreAfterContinuationMs).toBe(70);
    expect(result.restartAfterRestoreMs).toBe(90);
  });
});

describe("voice E2E harness latency summary", () => {
  it("scores first response latency from a real timestamp set", () => {
    const result = scoreFirstResponseLatency({
      turnStartedAtMs: 100,
      asrFinalAtMs: 420,
      llmFirstTokenAtMs: 700,
      ttsFirstAudioAtMs: 980,
      audioFirstPlayedAtMs: 1005,
      maxFirstAudioMs: 1000,
    });
    expect(result.passed).toBe(true);
    expect(result.firstAudioMs).toBe(880);
    expect(result.firstPlayedMs).toBe(905);
  });

  it("summarizes all case pass/fail flags", () => {
    const summary = summarizeVoiceE2e([
      scoreTtsAsrRoundTrip({
        referenceText: "hello",
        hypothesisText: "hello",
      }),
      scoreFirstResponseLatency({
        turnStartedAtMs: 0,
        ttsFirstAudioAtMs: 400,
      }),
    ]);
    expect(summary.passed).toBe(true);
    expect(summary.cases).toHaveLength(2);
  });
});
