/**
 * Unit coverage for the agent DB bridge's final-persistence diagnostic
 * projection: every settlement written by the patched `completeStep` funnel
 * composes runtime-known-secret redaction with the shared tool-shape
 * patterns over parameters and result/failure metadata while preserving
 * identity, numeric, and boolean fields. Deterministic; the runtime is a
 * minimal stub and every credential-shaped value is a synthetic canary.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { TrajectoryActionAttempt } from "../types/trajectory.ts";
import { projectSettledActionDiagnostics } from "./trajectory-storage.ts";

const RUNTIME_SECRET = "SYNTH-AGENT-RUNTIME-SECRET-CANARY-1111";
const FLAG_CANARY = "SYNTH-AGENT-FLAG-CANARY-2222";
const URI_CANARY = "SYNTH-AGENT-URI-CANARY-3333";

const runtime = {
  redactSecrets: (text: string) =>
    text.split(RUNTIME_SECRET).join("[REDACTED:AGENT_CANARY]"),
} as unknown as IAgentRuntime;

function makeAttempt(): TrajectoryActionAttempt {
  return {
    attemptId: "attempt-1",
    timestamp: 1_000,
    actionType: "CANARY_TOOL",
    actionName: "CANARY_TOOL",
    parameters: {
      command: `deploy --token=${FLAG_CANARY} ${RUNTIME_SECRET}`,
      target: `https://canary:${URI_CANARY}@synthetic.invalid/`,
      retries: 4,
      dryRun: true,
    },
    success: false,
    result: { stderr: `auth failed for --token=${FLAG_CANARY}` },
    error: `rejected ${RUNTIME_SECRET}`,
    immediateReward: -0.1,
  };
}

describe("projectSettledActionDiagnostics", () => {
  it("excludes every canary from the persisted settlement", () => {
    const projected = projectSettledActionDiagnostics(runtime, makeAttempt());
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(RUNTIME_SECRET);
    expect(serialized).not.toContain(FLAG_CANARY);
    expect(serialized).not.toContain(URI_CANARY);
  });

  it("preserves identity, numbers, and booleans for correlation", () => {
    const projected = projectSettledActionDiagnostics(runtime, makeAttempt());
    expect(projected.attemptId).toBe("attempt-1");
    expect(projected.timestamp).toBe(1_000);
    expect(projected.actionName).toBe("CANARY_TOOL");
    expect(projected.parameters.retries).toBe(4);
    expect(projected.parameters.dryRun).toBe(true);
    expect(projected.success).toBe(false);
    expect(projected.immediateReward).toBe(-0.1);
  });

  it("does not mutate the settlement it was given", () => {
    const attempt = makeAttempt();
    projectSettledActionDiagnostics(runtime, attempt);
    expect(attempt.parameters.command).toContain(FLAG_CANARY);
    expect(attempt.error).toContain(RUNTIME_SECRET);
  });
});
