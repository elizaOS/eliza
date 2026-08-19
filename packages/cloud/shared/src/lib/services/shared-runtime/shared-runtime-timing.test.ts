/**
 * Deterministically exercises bounded per-turn runtime timing receipts,
 * including concurrent isolation and incomplete failure paths.
 */

import { describe, expect, test } from "bun:test";
import { SharedRuntimeTimingCollector } from "./shared-runtime-timing";

function clock(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

describe("SharedRuntimeTimingCollector", () => {
  test("keeps phase durations distinct from turn-relative offsets", () => {
    const timing = new SharedRuntimeTimingCollector(
      "trace-a",
      3,
      clock([100, 110, 115, 125, 130, 145, 150, 170, 190, 220, 250]),
    );
    timing.markEdgeContextReady();
    timing.markRuntimeInitializeStarted();
    timing.markRuntimeReady();
    timing.markConnectionStarted();
    timing.markConnectionReady();
    timing.markHistoryStarted();
    timing.markHistoryReady();
    timing.markProviderDispatched();
    timing.markProviderFirstText();

    expect(timing.receipt("success")).toEqual({
      traceId: "trace-a",
      outcome: "success",
      historyMessageCount: 3,
      phases: {
        edgeContextDurationMs: 10,
        runtimeInitializeDurationMs: 10,
        connectionDurationMs: 15,
        historyProjectionDurationMs: 20,
      },
      offsets: {
        providerDispatchOffsetMs: 90,
        providerFirstTextOffsetMs: 120,
        completedOffsetMs: 150,
      },
      inference: {
        composeStateDurationMs: null,
        shouldRespondAndContextDurationMs: null,
        responseHandlerFieldsDurationMs: null,
        providerTotalDurationMs: 0,
        slowestProviderDurationMs: null,
      },
      routing: {
        decision: "unknown",
        contextIds: [],
      },
    });
  });

  test("records content-free inference phases, provider totals, and routing", () => {
    const timing = new SharedRuntimeTimingCollector("trace-routing", 2, clock([0, 100]));
    timing.markInferenceSpans([
      { name: "composeState", durationMs: 42.25 },
      { name: "provider:CHARACTER", durationMs: 10.04 },
      { name: "provider:RECENT_MESSAGES", durationMs: 31.16 },
      { name: "message:planner", durationMs: 188.88 },
      { name: "evaluators:response-handler-fields", durationMs: 3.33 },
    ]);
    timing.markRoutingDecision("silent", ["Simple", "memory", "simple", "not private"]);

    expect(timing.receipt("success")).toMatchObject({
      inference: {
        composeStateDurationMs: 42.3,
        shouldRespondAndContextDurationMs: 188.9,
        responseHandlerFieldsDurationMs: 3.3,
        providerTotalDurationMs: 41.2,
        slowestProviderDurationMs: 31.2,
      },
      routing: {
        decision: "silent",
        contextIds: ["simple", "memory"],
      },
    });
  });

  test("isolates concurrent turns and emits partial aborted receipts", () => {
    const first = new SharedRuntimeTimingCollector("first", 0, clock([0, 10, 20]));
    const second = new SharedRuntimeTimingCollector("second", 7, clock([100, 130, 160]));
    first.markEdgeContextReady();
    second.markProviderDispatched();

    expect(first.receipt("aborted")).toMatchObject({
      traceId: "first",
      outcome: "aborted",
      phases: { edgeContextDurationMs: 10 },
      offsets: { providerDispatchOffsetMs: null, completedOffsetMs: 20 },
    });
    expect(second.receipt("error")).toMatchObject({
      traceId: "second",
      outcome: "error",
      historyMessageCount: 7,
      phases: { edgeContextDurationMs: null },
      offsets: { providerDispatchOffsetMs: 30, completedOffsetMs: 60 },
    });
  });

  test("rejects invalid durations and caps pathological values", () => {
    const timing = new SharedRuntimeTimingCollector("bounded", 0, clock([50, 40, 700_100]));
    timing.markProviderDispatched();
    const receipt = timing.receipt("error");
    expect(receipt.offsets.providerDispatchOffsetMs).toBeNull();
    expect(receipt.offsets.completedOffsetMs).toBe(600_000);
  });
});
