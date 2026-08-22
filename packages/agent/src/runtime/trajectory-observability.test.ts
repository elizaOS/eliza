/**
 * Covers trajectory-persistence failure boundaries: observation extraction is
 * diagnostic-only, while public source aggregation fails instead of returning
 * a healthy-empty result. Deterministic hand-built collaborators drive errors.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  appendCompleteTrajectoryTextRecords,
  capScriptForPersistence,
  computeBySource,
  extractInsightsFromResponse,
  flushObservationBuffer,
  pushChatExchange,
} from "./trajectory-internals";

function createRuntime() {
  const warn = vi.fn();
  const reportError = vi.fn();
  const runtime = {
    agentId: "trajectory-observability-test",
    actions: [],
    adapter: { db: undefined },
    logger: { warn },
    reportError,
    useModel: vi.fn(async () => {
      throw new Error("model down");
    }),
  } as unknown as IAgentRuntime;
  return { runtime, reportError, warn };
}

describe("trajectory observability", () => {
  it("preserves every ordered metadata record across former recency caps", () => {
    const existing = Array.from({ length: 35 }, (_, index) => `old-${index}`);
    const additions = [
      "duplicate",
      "duplicate",
      ...Array.from({ length: 25 }, (_, index) => `new-${index}`),
    ];

    const records = appendCompleteTrajectoryTextRecords(
      existing,
      additions,
      "insights",
    );

    expect(records).toEqual([...existing, ...additions]);
    expect(records).toHaveLength(62);
  });

  it("rejects malformed persisted metadata instead of treating it as empty", () => {
    expect(() =>
      appendCompleteTrajectoryTextRecords(["valid", 3], ["next"], "insights"),
    ).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_TEXT_METADATA_INVALID" }),
    );
  });

  it("preserves long and whitespace-significant extracted trajectory text", () => {
    const decision = `${"x".repeat(1_500)}  `;
    const reasoning = `${"reasoning ".repeat(40)}  `;

    expect(
      extractInsightsFromResponse(`DECISION: ${decision}\n`, "coordination"),
    ).toEqual([decision]);
    expect(
      extractInsightsFromResponse(
        JSON.stringify({ reasoning }),
        "coordination",
      ),
    ).toEqual([reasoning]);
  });

  it("rejects malformed Unicode instead of repairing recorded context", () => {
    expect(() => capScriptForPersistence("bad\ud800script")).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_TEXT_MALFORMED_UNICODE" }),
    );
    expect(() =>
      appendCompleteTrajectoryTextRecords([], ["bad\ud800insight"], "insights"),
    ).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_TEXT_MALFORMED_UNICODE" }),
    );
  });

  it("logs observation flush failures before returning an empty result", async () => {
    const { runtime, reportError, warn } = createRuntime();
    pushChatExchange(runtime, {
      userPrompt: "hello",
      response: "hi",
      trajectoryId: "trajectory-1",
      timestamp: Date.now(),
    });

    await expect(flushObservationBuffer(runtime)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        subsystem: "trajectory-db",
      }),
      "[trajectory-persistence] observation flush failed",
    );
    expect(reportError).toHaveBeenCalledWith(
      "TrajectoryPersistence.flushObservationBuffer",
      expect.any(Error),
      { agentId: "trajectory-observability-test" },
    );
  });

  it("does not cap observation-extraction model output", async () => {
    const { runtime } = createRuntime();
    const useModel = vi.mocked(runtime.useModel);
    useModel.mockImplementation(async (_modelType, params) => {
      expect(params).not.toHaveProperty("maxTokens");
      return JSON.stringify([`HEAD${"x".repeat(2_000)}TAIL`]);
    });
    pushChatExchange(runtime, {
      userPrompt: "extract complete observations",
      response: "complete response",
      trajectoryId: "trajectory-complete-output",
      timestamp: Date.now(),
    });

    await expect(flushObservationBuffer(runtime)).resolves.toEqual([]);
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("rejects source aggregation failures instead of fabricating an empty result", async () => {
    const { runtime, warn } = createRuntime();

    await expect(computeBySource(runtime)).rejects.toThrow(
      "runtime database adapter unavailable",
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
