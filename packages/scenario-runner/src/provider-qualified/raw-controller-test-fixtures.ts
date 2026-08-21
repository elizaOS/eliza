/**
 * Creates real canonical trajectory files for raw-controller contract tests.
 * The artifacts are deterministic in shape but always fresh and are verified
 * by the production filesystem verifier rather than replaced with a mock.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import type { DeployedTrajectoryRunMaterial } from "./raw-controller-contracts.ts";

const runDirectories = new Set<string>();

afterAll(() => {
  for (const runDirectory of runDirectories) {
    rmSync(runDirectory, { recursive: true, force: true });
  }
  runDirectories.clear();
});

export function createRawControllerTrajectoryMaterial(input: {
  runId: string;
  scenarioId: string;
  baseMs: number;
}): DeployedTrajectoryRunMaterial {
  const runDir = mkdtempSync(path.join(tmpdir(), "raw-provider-controller-"));
  runDirectories.add(runDir);
  const relativePath = "trajectories/operator/trajectory-1.json";
  const filePath = path.join(runDir, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  const startedAt = input.baseMs - 4;
  const endedAt = input.baseMs - 1;
  writeFileSync(
    filePath,
    `${JSON.stringify({
      trajectoryId: "trajectory-1",
      agentId: "operator-agent",
      runId: input.runId,
      scenarioId: input.scenarioId,
      rootMessage: { id: "provider-ingress", text: "provider canary" },
      startedAt,
      endedAt,
      status: "finished",
      stages: [
        {
          stageId: "provider-operation",
          kind: "tool",
          startedAt,
          endedAt,
          latencyMs: 3,
          tool: {
            name: "PROVIDER_CANARY_OPERATION",
            args: { scenarioId: input.scenarioId },
            result: { accepted: true },
            success: true,
            durationMs: 3,
          },
        },
      ],
      metrics: {
        totalLatencyMs: 3,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalCostUsd: 0,
        plannerIterations: 1,
        toolCallsExecuted: 1,
        toolCallFailures: 0,
        toolSearchCount: 0,
        evaluatorFailures: 0,
        finalDecision: "FINISH",
      },
    })}\n`,
  );
  return Object.freeze({
    runDir,
    runId: input.runId,
    scenarioId: input.scenarioId,
    scenarioStartedAtIso: new Date(input.baseMs - 5).toISOString(),
    scenarioEndedAtIso: new Date(input.baseMs).toISOString(),
    environment: "provider-test",
    expectedRelativePaths: Object.freeze([relativePath]),
  });
}
