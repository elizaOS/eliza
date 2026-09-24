/**
 * End-to-end mock runner tests for the voice RTT harness.
 */

import { describe, expect, it } from "vitest";
import { runBenchmark } from "../src/runner.ts";

describe("mock benchmark", () => {
  it("runs deterministically, passes gates, and records cancellation", async () => {
    const first = await runBenchmark({
      mode: "mock",
      runs: 1,
      timeoutMs: 1000,
      unsafeTranscripts: false,
      enforceLiveGates: false,
      nowIso: () => "2026-07-10T00:00:00.000Z",
    });
    const second = await runBenchmark({
      mode: "mock",
      runs: 1,
      timeoutMs: 1000,
      unsafeTranscripts: false,
      enforceLiveGates: false,
      nowIso: () => "2026-07-10T00:00:00.000Z",
    });
    const normalize = (value: typeof first) =>
      value.results.map((result) => ({
        caseId: result.caseId,
        stages: result.stages,
        cancelled: result.trace.cancelled,
        postInterruptAudioFrames: result.trace.postInterruptAudioFrames,
      }));
    expect(normalize(first)).toEqual(normalize(second));
    expect(first.gates.passed).toBe(true);
    const bargeIn = first.results.find((result) => result.kind === "barge-in");
    expect(bargeIn?.trace.cancelled).toBe(true);
    expect(bargeIn?.trace.postInterruptAudioFrames).toBe(0);
    expect(bargeIn?.stages.interruptToSilenceMs).toBeLessThan(300);
    for (const result of first.results) {
      expect(result.trace.transcript).toBeUndefined();
      expect(result.trace.replyText).toBeUndefined();
    }
  });
});
