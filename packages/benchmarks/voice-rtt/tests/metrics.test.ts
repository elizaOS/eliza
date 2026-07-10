/**
 * Deterministic checks for voice RTT percentile, attribution, and gate math.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateGates,
  percentile,
  stageAttribution,
  summarize,
} from "../src/metrics.ts";
import type { CaseResult, StageDurations } from "../src/types.ts";

describe("metrics", () => {
  it("uses nearest-rank percentiles", () => {
    expect(percentile([400, 100, 300, 200], 50)).toBe(200);
    expect(percentile([400, 100, 300, 200], 90)).toBe(400);
    expect(percentile([400, 100, 300, 200], 95)).toBe(400);
    expect(percentile([], 50)).toBeNull();
  });

  it("keeps missing measurements out of summaries", () => {
    expect(summarize([10, null, 30])).toMatchObject({
      count: 2,
      min: 10,
      max: 30,
      mean: 20,
      p50: 10,
      p90: 30,
      p95: 30,
    });
  });

  it("sorts p50 stage attribution by contribution", () => {
    const summaries = Object.fromEntries(
      stageKeys.map((stage) => [
        stage,
        {
          count: 1,
          min: 1,
          max: 1,
          mean: 1,
          p50: stage === "ttsRequestToFirstAudioMs" ? 200 : 10,
          p90: 1,
          p95: 1,
        },
      ]),
    ) as Record<keyof StageDurations, ReturnType<typeof summarize>>;
    expect(stageAttribution(summaries)[0]).toMatchObject({
      stage: "ttsRequestToFirstAudioMs",
      p50Ms: 200,
    });
  });

  it("omits missing measurements from stage attribution", () => {
    const summaries = Object.fromEntries(
      stageKeys.map((stage) => [stage, summarize([10])]),
    ) as Record<keyof StageDurations, ReturnType<typeof summarize>>;
    summaries.preforwardToFirstTokenMs = summarize([null]);

    expect(
      stageAttribution(summaries).map((entry) => entry.stage),
    ).not.toContain("preforwardToFirstTokenMs");
  });

  it("enforces mock gates and leaves advisory live gates passable", () => {
    const summaries = Object.fromEntries(
      stageKeys.map((stage) => [
        stage,
        {
          count: 1,
          min: 0,
          max: 0,
          mean: 0,
          p50: stage === "eosToFirstAudioMs" ? 1200 : 0,
          p90: stage === "eosToFirstAudioMs" ? 1600 : 0,
          p95: stage === "eosToFirstAudioMs" ? 1600 : 0,
        },
      ]),
    ) as Record<keyof StageDurations, ReturnType<typeof summarize>>;
    const results: CaseResult[] = [];
    expect(evaluateGates({ summaries, results, enforced: true }).passed).toBe(
      false,
    );
    expect(evaluateGates({ summaries, results, enforced: false }).passed).toBe(
      true,
    );
  });

  it("fails equality against strict latency targets", () => {
    const summaries = Object.fromEntries(
      stageKeys.map((stage) => [
        stage,
        {
          count: 1,
          min: stage === "eosToFirstAudioMs" ? 1000 : 0,
          max: stage === "eosToFirstAudioMs" ? 1500 : 0,
          mean: 0,
          p50: stage === "eosToFirstAudioMs" ? 1000 : 0,
          p90: stage === "eosToFirstAudioMs" ? 1500 : 0,
          p95: stage === "eosToFirstAudioMs" ? 1500 : 0,
        },
      ]),
    ) as Record<keyof StageDurations, ReturnType<typeof summarize>>;
    const results: CaseResult[] = [
      {
        caseId: "barge-in",
        kind: "barge-in",
        runIndex: 0,
        trace: {
          traceId: "trace",
          mode: "mock",
          caseId: "barge-in",
          runIndex: 0,
          checkpoints: [],
          serverTiming: [],
          lengths: {
            inputAudioMs: 0,
            transcriptChars: 0,
            replyChars: 0,
            firstSpeakablePhraseChars: 0,
            firstAudioBytes: 0,
          },
          cancelled: true,
          postInterruptAudioFrames: 0,
          providerRequestIds: {},
          errors: [],
        },
        stages: {
          acousticEndToSttEagerMs: 0,
          acousticEndToSttFinalMs: 0,
          sttFinalToChatAdmissionMs: 0,
          chatAdmissionToPreforwardMs: 0,
          preforwardToFirstTokenMs: 0,
          firstTokenToSpeakablePhraseMs: 0,
          speakablePhraseToTtsRequestMs: 0,
          ttsRequestToFirstAudioMs: 0,
          firstAudioToPlayoutMs: 0,
          eosToFirstAudioMs: 1000,
          interruptToSilenceMs: 300,
        },
      },
    ];
    const gates = evaluateGates({ summaries, results, enforced: true });

    expect(gates.passed).toBe(false);
    expect(gates.failures).toEqual(
      expect.arrayContaining([
        "EOS to first audio P50 1000ms must be less than 1000ms",
        "EOS to first audio P95 1500ms must be less than 1500ms",
        "interruption to silence 300ms must be less than 300ms",
      ]),
    );
  });
});

const stageKeys: Array<keyof StageDurations> = [
  "acousticEndToSttEagerMs",
  "acousticEndToSttFinalMs",
  "sttFinalToChatAdmissionMs",
  "chatAdmissionToPreforwardMs",
  "preforwardToFirstTokenMs",
  "firstTokenToSpeakablePhraseMs",
  "speakablePhraseToTtsRequestMs",
  "ttsRequestToFirstAudioMs",
  "firstAudioToPlayoutMs",
  "eosToFirstAudioMs",
  "interruptToSilenceMs",
];
