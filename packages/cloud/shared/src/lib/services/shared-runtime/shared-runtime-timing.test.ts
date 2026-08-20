/**
 * Deterministically exercises bounded per-turn runtime timing receipts,
 * including concurrent isolation and incomplete failure paths.
 */

import { describe, expect, test } from "bun:test";
import {
  parseSharedProviderTimingReceipt,
  SharedRuntimeTimingCollector,
} from "./shared-runtime-timing";

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
      model: {
        replayed: false,
        durationMs: 0,
        callCount: 0,
        fallbackCount: 0,
        selectedProvider: "none",
        callsTruncated: false,
        calls: [],
      },
      routing: {
        decision: "unknown",
        contextIds: [],
      },
    });
  });

  test("excludes dispatch and setup before the SDK invocation begins", () => {
    const timing = new SharedRuntimeTimingCollector("provider", 0, clock([0, 100, 145, 200, 220]));
    timing.markProviderDispatched();
    const call = timing.prepareModelCall();
    call.select({ provider: "openrouter", fallback: true });
    call.begin();
    call.finish();

    expect(timing.receipt("success").model).toEqual({
      replayed: false,
      durationMs: 55,
      callCount: 1,
      fallbackCount: 1,
      selectedProvider: "openrouter",
      callsTruncated: false,
      calls: [{ provider: "openrouter", durationMs: 55, fallback: true }],
    });
  });

  test("keeps exact aggregate counts while truncating only the first-16 call list", () => {
    let now = 0;
    const timing = new SharedRuntimeTimingCollector("many-provider-calls", 0, () => now++);
    for (let index = 0; index < 17; index += 1) {
      const call = timing.prepareModelCall();
      call.select(
        index === 16
          ? { provider: "openrouter", fallback: true }
          : { provider: "cerebras", fallback: false },
      );
      call.begin();
      call.finish();
    }

    expect(timing.receipt("success").model).toMatchObject({
      durationMs: 17,
      callCount: 17,
      fallbackCount: 1,
      selectedProvider: "mixed",
      callsTruncated: true,
    });
    expect(timing.receipt("success").model.calls).toHaveLength(16);
  });

  test("canonicalizes a valid receipt and strips undeclared transport fields", () => {
    expect(
      parseSharedProviderTimingReceipt({
        replayed: false,
        durationMs: 8.1,
        callCount: 2,
        fallbackCount: 1,
        selectedProvider: "mixed",
        callsTruncated: false,
        privateTrace: "drop-me",
        calls: [
          {
            provider: "cerebras",
            durationMs: 3,
            fallback: false,
            privateProviderMetadata: "drop-me",
          },
          { provider: "openrouter", durationMs: 5.1, fallback: true },
        ],
      }),
    ).toEqual({
      replayed: false,
      durationMs: 8.1,
      callCount: 2,
      fallbackCount: 1,
      selectedProvider: "mixed",
      callsTruncated: false,
      calls: [
        { provider: "cerebras", durationMs: 3, fallback: false },
        { provider: "openrouter", durationMs: 5.1, fallback: true },
      ],
    });
  });

  test("rejects internally impossible untrusted receipts", () => {
    const base = {
      replayed: false,
      durationMs: 1,
      callCount: 1,
      fallbackCount: 0,
      selectedProvider: "cerebras",
      callsTruncated: false,
      calls: [{ provider: "cerebras", durationMs: 1, fallback: false }],
    };
    expect(parseSharedProviderTimingReceipt(base)).toBeDefined();
    expect(parseSharedProviderTimingReceipt({ ...base, fallbackCount: 1 })).toBeUndefined();
    expect(
      parseSharedProviderTimingReceipt({ ...base, selectedProvider: "mixed" }),
    ).toBeUndefined();
    expect(parseSharedProviderTimingReceipt({ ...base, durationMs: 2 })).toBeUndefined();
    expect(
      parseSharedProviderTimingReceipt({
        ...base,
        calls: [{ provider: "cerebras", durationMs: 1, fallback: true }],
      }),
    ).toBeUndefined();
    expect(
      parseSharedProviderTimingReceipt({
        ...base,
        callCount: 0,
        durationMs: 0,
        calls: [],
        selectedProvider: "openrouter",
      }),
    ).toBeUndefined();
  });

  test("accepts an internally possible first-16 truncated receipt", () => {
    const calls = Array.from({ length: 16 }, () => ({
      provider: "cerebras",
      durationMs: 1,
      fallback: false,
    }));
    expect(
      parseSharedProviderTimingReceipt({
        replayed: false,
        durationMs: 17,
        callCount: 17,
        fallbackCount: 1,
        selectedProvider: "mixed",
        callsTruncated: true,
        calls,
      }),
    ).toMatchObject({
      callCount: 17,
      fallbackCount: 1,
      selectedProvider: "mixed",
      callsTruncated: true,
      calls,
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

  test("rejects invalid and over-limit durations instead of fabricating boundary values", () => {
    const timing = new SharedRuntimeTimingCollector("bounded", 0, clock([50, 40, 700_100]));
    timing.markProviderDispatched();
    timing.markInferenceSpans([
      { name: "provider:first", durationMs: 400_000 },
      { name: "provider:second", durationMs: 300_001 },
      { name: "composeState", durationMs: Number.POSITIVE_INFINITY },
    ]);
    const receipt = timing.receipt("error");
    expect(receipt.offsets.providerDispatchOffsetMs).toBeNull();
    expect(receipt.offsets.completedOffsetMs).toBeNull();
    expect(receipt.inference.providerTotalDurationMs).toBeNull();
    expect(receipt.inference.composeStateDurationMs).toBeNull();
  });
});
