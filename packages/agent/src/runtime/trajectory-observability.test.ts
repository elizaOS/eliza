/**
 * Covers trajectory-persistence observability: when the observation-buffer
 * flush or the by-source aggregation fails, the error is logged (warn carrying
 * err + subsystem "trajectory-db") before an empty result is returned.
 * Deterministic — a hand-built runtime whose adapter/model throw.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  computeBySource,
  flushObservationBuffer,
  pushChatExchange,
} from "./trajectory-internals";

function createRuntime() {
  const warn = vi.fn();
  const runtime = {
    actions: [],
    adapter: { db: undefined },
    logger: { warn },
    useModel: vi.fn(async () => {
      throw new Error("model down");
    }),
  } as unknown as IAgentRuntime;
  return { runtime, warn };
}

describe("trajectory observability", () => {
  it("logs observation flush failures before returning an empty result", async () => {
    const { runtime, warn } = createRuntime();
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
  });

  it("logs source aggregation failures before returning an empty result", async () => {
    const { runtime, warn } = createRuntime();

    await expect(computeBySource(runtime)).resolves.toEqual({});

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        subsystem: "trajectory-db",
      }),
      "[trajectory-persistence] source aggregation failed",
    );
  });
});
