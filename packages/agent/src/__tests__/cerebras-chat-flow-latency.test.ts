/**
 * Validates the deterministic statistics and proof checks used by the live
 * Cerebras chat-flow harness; provider execution remains in the live lane.
 */
import { describe, expect, it } from "vitest";
import {
  distribution,
  percentile,
  providerParallelismRatio,
  verifyProofResponse,
  verifyProviderSweepTelemetry,
} from "../../scripts/cerebras-chat-flow-latency";

describe("Cerebras chat-flow latency helpers", () => {
  it("uses nearest-rank percentiles and reports the full distribution", () => {
    const samples = [9, 1, 5, 3, 7];
    expect(
      percentile(
        [...samples].sort((a, b) => a - b),
        95,
      ),
    ).toBe(9);
    expect(distribution(samples)).toEqual({
      count: 5,
      min: 1,
      p50: 5,
      p90: 9,
      p95: 9,
      p99: 9,
      max: 9,
      mean: 5,
    });
  });

  it("accepts punctuation around a distinct proof and rejects stale output", () => {
    expect(() =>
      verifyProofResponse('"SPEED-S-4".', "SPEED-S-4"),
    ).not.toThrow();
    expect(() => verifyProofResponse("SPEED-S-3", "SPEED-S-4")).toThrow(
      "did not contain the requested proof",
    );
  });

  it("requires every provider to execute fresh and then hit cache exactly", () => {
    const fresh = [
      {
        providerName: "FACTS",
        execution: {
          count: 2,
          min: 1,
          p50: 1,
          p90: 2,
          p95: 2,
          p99: 2,
          max: 2,
          mean: 1.5,
        },
        cacheHits: 0,
        successes: 2,
        errors: 0,
        aborted: 0,
        deadlineExceeded: 0,
        coalesced: 0,
        unknown: 0,
      },
    ];
    const reused = [
      {
        providerName: "FACTS",
        execution: {
          count: 0,
          min: null,
          p50: null,
          p90: null,
          p95: null,
          p99: null,
          max: null,
          mean: null,
        },
        cacheHits: 2,
        successes: 0,
        errors: 0,
        aborted: 0,
        deadlineExceeded: 0,
        coalesced: 0,
        unknown: 0,
      },
    ];

    expect(() =>
      verifyProviderSweepTelemetry(["FACTS"], fresh, reused, 2),
    ).not.toThrow();
    expect(() =>
      verifyProviderSweepTelemetry(
        ["FACTS"],
        [{ ...fresh[0], successes: 1 }],
        reused,
        2,
      ),
    ).toThrow("invalid fresh telemetry");
  });

  it("reports overlapped provider work as a wall-time ratio", () => {
    expect(
      providerParallelismRatio({
        turnId: "provider-sweep",
        label: "provider-sweep",
        roomId: null,
        modelProvider: null,
        t0EpochMs: 0,
        closedAtEpochMs: 10,
        totalMs: 10,
        timeToFirstTokenMs: null,
        timeToFirstVisibleMs: null,
        timeToReplyMs: null,
        timeToResponseFinalizedMs: null,
        spans: [
          {
            name: "provider:FACTS",
            startMs: 0,
            endMs: 8,
            durationMs: 8,
            meta: { outcome: "success" },
          },
          {
            name: "provider:WORLD",
            startMs: 0,
            endMs: 7,
            durationMs: 7,
            meta: { outcome: "success" },
          },
        ],
        marks: [],
        byName: {},
        anomalies: [],
      }),
    ).toBe(1.5);
  });
});
