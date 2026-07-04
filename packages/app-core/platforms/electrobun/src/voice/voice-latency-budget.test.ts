/** Exercises voice latency budget behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  evaluateVoiceLatencyBudget,
  getDefaultVoiceLatencyBudget,
  getVoiceLatencyBudgetFromEnv,
} from "./voice-latency-budget";

describe("voice latency budget", () => {
  it("uses the default budget targets", () => {
    expect(getDefaultVoiceLatencyBudget()).toMatchObject({
      inputToVadMs: 50,
      vadToAsrPartialMs: 150,
      asrPartialToRuntimePrepareMs: 100,
      asrFinalToRuntimeCommitMs: 100,
      runtimeToFirstTokenMs: 500,
      firstTokenToTtsRequestMs: 80,
      ttsRequestToFirstAudioMs: 400,
      firstAudioToPlaybackMs: 100,
      totalToFirstTokenMs: 900,
      totalToFirstAudioMs: 1200,
      totalToPlaybackMs: 1400,
    });
  });

  it("reads positive integer overrides from env", () => {
    const budget = getVoiceLatencyBudgetFromEnv({
      ELIZA_VOICE_BUDGET_RUNTIME_TO_FIRST_TOKEN_MS: "250",
      ELIZA_VOICE_BUDGET_TOTAL_TO_PLAYBACK_MS: "900",
      ELIZA_VOICE_BUDGET_INPUT_TO_VAD_MS: "-1",
    });

    expect(budget.runtimeToFirstTokenMs).toBe(250);
    expect(budget.totalToPlaybackMs).toBe(900);
    expect(budget.inputToVadMs).toBe(50);
  });

  it("evaluates stage pass and miss results", () => {
    const results = evaluateVoiceLatencyBudget(
      {
        inputToVadMs: 40,
        runtimeToFirstTokenMs: 501,
        totalToPlaybackMs: 1300,
      },
      getDefaultVoiceLatencyBudget(),
    );

    expect(results).toContainEqual({
      stage: "input_to_vad",
      actualMs: 40,
      budgetMs: 50,
      ok: true,
    });
    expect(results).toContainEqual({
      stage: "runtime_to_first_token",
      actualMs: 501,
      budgetMs: 500,
      ok: false,
    });
    expect(results).toContainEqual({
      stage: "total_to_playback",
      actualMs: 1300,
      budgetMs: 1400,
      ok: true,
    });
  });
});
