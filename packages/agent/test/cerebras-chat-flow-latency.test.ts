/**
 * Validates the deterministic statistics and proof checks used by the live
 * Cerebras chat-flow harness; provider execution remains in the live lane.
 */
import { describe, expect, it } from "vitest";
import {
  distribution,
  modelUsageEvidence,
  percentile,
  verifyExactResponseParity,
  verifyProofResponse,
} from "../scripts/cerebras-chat-flow-latency";

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

  it("requires the append-only stream to equal the authoritative final reply", () => {
    expect(() =>
      verifyExactResponseParity("SPEED-S-4", "SPEED-S-4"),
    ).not.toThrow();
    expect(() => verifyExactResponseParity("SPEED-", "SPEED-S-4")).toThrow(
      "did not exactly match",
    );
  });

  it("retains concrete Cerebras model and token attribution", () => {
    expect(
      modelUsageEvidence(
        {
          runtime: {} as never,
          source: "openai",
          provider: "cerebras",
          type: "RESPONSE_HANDLER",
          model: "gemma-4-31b",
          modelName: "gemma-4-31b",
          modelLabel: "RESPONSE_HANDLER",
          tokens: {
            prompt: 120,
            completion: 8,
            total: 128,
            cachedInputTokens: 64,
          },
        },
        "gemma-4-31b",
      ),
    ).toEqual({
      provider: "cerebras",
      model: "gemma-4-31b",
      modelName: "gemma-4-31b",
      modelLabel: "RESPONSE_HANDLER",
      type: "RESPONSE_HANDLER",
      tokens: {
        prompt: 120,
        completion: 8,
        total: 128,
        cachedInputTokens: 64,
      },
    });
  });

  it("rejects logical slots and transport labels as concrete attribution", () => {
    expect(() =>
      modelUsageEvidence(
        {
          runtime: {} as never,
          source: "openai",
          provider: "openai",
          type: "RESPONSE_HANDLER",
          model: "RESPONSE_HANDLER",
          modelName: "RESPONSE_HANDLER",
          tokens: { prompt: 1, completion: 1, total: 2 },
        },
        "gemma-4-31b",
      ),
    ).toThrow("Expected MODEL_USED provider cerebras");
  });
});
