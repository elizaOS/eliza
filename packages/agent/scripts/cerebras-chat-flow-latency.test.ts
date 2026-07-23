/**
 * Validates the deterministic statistics and proof checks used by the live
 * Cerebras chat-flow harness; provider execution remains in the live lane.
 */
import { describe, expect, it } from "vitest";
import {
  distribution,
  percentile,
  verifyProofResponse,
} from "./cerebras-chat-flow-latency";

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
});
