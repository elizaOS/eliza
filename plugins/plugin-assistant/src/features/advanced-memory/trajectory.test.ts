/** Advanced-memory provider telemetry goes to the running trajectory step. */
import {
  type IAgentRuntime,
  type Memory,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { logAdvancedMemoryTrajectory } from "./trajectory";

function log(message: Memory) {
  const logProviderAccess = vi.fn();
  const runtime = {
    getService: () => ({ logProviderAccess }),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  logAdvancedMemoryTrajectory({
    runtime,
    message,
    providerName: "LONG_TERM_MEMORY_EXTRACTION",
    purpose: "evaluate",
    data: {},
  });
  return logProviderAccess.mock.calls.map(([access]) => access.stepId);
}

const stored = {
  metadata: { type: "message", trajectoryStepId: "closed-step" },
} as unknown as Memory;

describe("logAdvancedMemoryTrajectory", () => {
  it("logs to the running step, not the stored message's closed one", () => {
    expect(
      runWithTrajectoryContext({ trajectoryStepId: "running-step" }, () =>
        log(stored),
      ),
    ).toEqual(["running-step"]);
  });

  it("falls back to the message's step outside a trajectory", () => {
    expect(log(stored)).toEqual(["closed-step"]);
  });
});
