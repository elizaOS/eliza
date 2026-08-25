/**
 * Unit tests for runtime replacement quiescence helper.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { quiesceRuntimeBeforeReplacement } from "./runtime-replacement-ownership.js";

describe("quiesceRuntimeBeforeReplacement", () => {
  it("does nothing when previous runtime is null", async () => {
    const newRuntime = {} as AgentRuntime;
    await expect(
      quiesceRuntimeBeforeReplacement(null, newRuntime),
    ).resolves.toBeUndefined();
  });

  it("does nothing when previous runtime is identical to new runtime", async () => {
    const runtime = {
      roomHandlerQueue: {
        closeAdmissions: vi.fn(),
        quiesceAll: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as AgentRuntime;

    await quiesceRuntimeBeforeReplacement(runtime, runtime);

    expect(runtime.roomHandlerQueue.closeAdmissions).not.toHaveBeenCalled();
    expect(runtime.roomHandlerQueue.quiesceAll).not.toHaveBeenCalled();
  });

  it("closes admissions and quiesces previous runtime when replaced", async () => {
    const closeAdmissions = vi.fn();
    const quiesceAll = vi.fn().mockResolvedValue(undefined);

    const prevRuntime = {
      roomHandlerQueue: {
        closeAdmissions,
        quiesceAll,
      },
    } as unknown as AgentRuntime;

    const newRuntime = {
      roomHandlerQueue: {
        closeAdmissions: vi.fn(),
        quiesceAll: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as AgentRuntime;

    await quiesceRuntimeBeforeReplacement(prevRuntime, newRuntime);

    expect(closeAdmissions).toHaveBeenCalledTimes(1);
    expect(closeAdmissions).toHaveBeenCalledWith("runtime-replacement");
    expect(quiesceAll).toHaveBeenCalledTimes(1);
    expect(newRuntime.roomHandlerQueue.closeAdmissions).not.toHaveBeenCalled();
  });
});
