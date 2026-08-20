/**
 * Verifies the real filesystem trust boundary for provider trajectories,
 * including exact-byte hashing, stage hashing, freshness, path containment,
 * correlation, and immutable completion.
 */

import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "./manifest.ts";
import {
  validateVerifiedScenarioTrajectorySet,
  verifyScenarioTrajectories,
} from "./trajectory-verifier.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const base = Date.now();
  const runDir = mkdtempSync(path.join(tmpdir(), "provider-trajectory-"));
  roots.push(runDir);
  const trajectoryDirectory = path.join(runDir, "trajectories", "agent");
  mkdirSync(trajectoryDirectory, { recursive: true });
  const trajectory = {
    trajectoryId: "trajectory-1",
    agentId: "agent",
    runId: "run-1",
    scenarioId: "scenario-1",
    rootMessage: { id: "message-1", text: "Create the calendar event." },
    startedAt: base - 750,
    endedAt: base - 250,
    status: "finished",
    stages: [
      {
        stageId: "stage-tool-calendar",
        kind: "tool",
        startedAt: base - 650,
        endedAt: base - 350,
        latencyMs: 300,
        tool: {
          name: "CREATE_CALENDAR_EVENT",
          args: { title: "School pickup" },
          result: { accepted: true },
          success: true,
          durationMs: 300,
        },
      },
    ],
    metrics: {
      totalLatencyMs: 500,
      totalPromptTokens: 10,
      totalCompletionTokens: 5,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0.001,
      plannerIterations: 1,
      toolCallsExecuted: 1,
      toolCallFailures: 0,
      toolSearchCount: 0,
      evaluatorFailures: 0,
      finalDecision: "FINISH",
    },
  };
  const relativePath = "trajectories/agent/trajectory-1.json";
  const filePath = path.join(runDir, ...relativePath.split("/"));
  const bytes = `${JSON.stringify(trajectory, null, 2)}\n`;
  writeFileSync(filePath, bytes);
  const input = {
    runDir,
    runId: "run-1",
    scenarioId: "scenario-1",
    scenarioStartedAtIso: new Date(base - 1_000).toISOString(),
    scenarioEndedAtIso: new Date(base).toISOString(),
    environment: "provider-sandbox",
    expectedRelativePaths: [relativePath],
    now: new Date(base + 100),
  };
  return { base, runDir, trajectory, filePath, bytes, input };
}

describe("verifyScenarioTrajectories", () => {
  it("recomputes exact artifact bytes and canonical stage bytes", () => {
    const { trajectory, bytes, input } = fixture();
    const result = verifyScenarioTrajectories(input);

    expect(result.trajectories).toHaveLength(1);
    expect(result.trajectories[0]?.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.trajectories[0]?.stages[0]?.sha256).toBe(
      canonicalSha256(trajectory.stages[0], "stage"),
    );
    expect(result.trajectories[0]?.stages[0]?.tool).toEqual({
      name: "CREATE_CALENDAR_EVENT",
      argsSha256: canonicalSha256(
        trajectory.stages[0].tool.args,
        "trajectory[0].stages[0].tool.args",
      ),
      resultSha256: canonicalSha256(
        trajectory.stages[0].tool.result,
        "trajectory[0].stages[0].tool.result",
      ),
      success: true,
    });
    expect(result.setSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      validateVerifiedScenarioTrajectorySet(JSON.parse(JSON.stringify(result))),
    ).toEqual(result);
  });

  it("rejects an empty set even when its claimed digest matches the empty list", () => {
    const { input } = fixture();
    const verified = verifyScenarioTrajectories(input);
    const empty = {
      ...verified,
      setSha256: canonicalSha256([], "verifiedTrajectories"),
      trajectories: [],
    };

    expect(() => validateVerifiedScenarioTrajectorySet(empty)).toThrow(
      /trajectories must be non-empty/,
    );
  });

  it.each([
    ["runId", "wrong-run", /wrong runId/],
    ["scenarioId", "wrong-scenario", /wrong scenarioId/],
    ["status", "running", /not finished/],
  ] as const)(
    "rejects a trajectory with %s mismatch",
    (field, value, pattern) => {
      const { trajectory, filePath, input } = fixture();
      Object.assign(trajectory, { [field]: value });
      writeFileSync(filePath, JSON.stringify(trajectory));
      expect(() => verifyScenarioTrajectories(input)).toThrow(pattern);
    },
  );

  it("rejects duplicate trajectory and stage identities", () => {
    const first = fixture();
    first.trajectory.stages.push({
      ...first.trajectory.stages[0],
    });
    writeFileSync(first.filePath, JSON.stringify(first.trajectory));
    expect(() => verifyScenarioTrajectories(first.input)).toThrow(
      /duplicate stageId/,
    );

    const second = fixture();
    const duplicateDirectory = path.join(
      second.runDir,
      "trajectories",
      "other-agent",
    );
    mkdirSync(duplicateDirectory, { recursive: true });
    writeFileSync(
      path.join(duplicateDirectory, "trajectory-1.json"),
      JSON.stringify(second.trajectory),
    );
    const input = {
      ...second.input,
      expectedRelativePaths: undefined,
    };
    expect(() => verifyScenarioTrajectories(input)).toThrow(
      /trajectoryId "trajectory-1" is duplicated/,
    );
  });

  it("rejects traversal and incomplete expected artifact sets", () => {
    const first = fixture();
    expect(() =>
      verifyScenarioTrajectories({
        ...first.input,
        expectedRelativePaths: ["../trajectory-1.json"],
      }),
    ).toThrow(/traversal/);

    const second = fixture();
    expect(() =>
      verifyScenarioTrajectories({
        ...second.input,
        expectedRelativePaths: ["trajectories/agent/missing.json"],
      }),
    ).toThrow(/do not exactly match/);
  });

  it("rejects symbolic links and unexpected files in the trajectory tree", () => {
    const first = fixture();
    const link = path.join(first.runDir, "trajectories", "linked.json");
    symlinkSync(first.filePath, link);
    expect(() =>
      verifyScenarioTrajectories({
        ...first.input,
        expectedRelativePaths: undefined,
      }),
    ).toThrow(/symbolic link/);

    const second = fixture();
    writeFileSync(
      path.join(second.runDir, "trajectories", "unverified.log"),
      "not evidence",
    );
    expect(() =>
      verifyScenarioTrajectories({
        ...second.input,
        expectedRelativePaths: undefined,
      }),
    ).toThrow(/unexpected non-JSON/);
  });

  it("rejects a hard-linked trajectory even when both names stay in-bounds", () => {
    const evidence = fixture();
    const aliasDirectory = path.join(
      evidence.runDir,
      "trajectories",
      "alias-agent",
    );
    mkdirSync(aliasDirectory, { recursive: true });
    linkSync(evidence.filePath, path.join(aliasDirectory, "trajectory-1.json"));

    expect(() =>
      verifyScenarioTrajectories({
        ...evidence.input,
        expectedRelativePaths: undefined,
      }),
    ).toThrow(/hard-linked artifact/);
  });

  it("rejects stale files, stale run directories, and inverted stages", () => {
    const staleFile = fixture();
    const ancient = new Date(staleFile.base - 60_000);
    utimesSync(staleFile.filePath, ancient, ancient);
    expect(() => verifyScenarioTrajectories(staleFile.input)).toThrow(/stale/);

    const staleDirectory = fixture();
    expect(() =>
      verifyScenarioTrajectories({
        ...staleDirectory.input,
        scenarioStartedAtIso: new Date(
          staleDirectory.base + 60_000,
        ).toISOString(),
        scenarioEndedAtIso: new Date(
          staleDirectory.base + 61_000,
        ).toISOString(),
        maxRunDirectoryAgeMs: 0,
        maxClockSkewMs: 0,
        now: new Date(staleDirectory.base + 62_000),
      }),
    ).toThrow(/not freshly created/);

    const inverted = fixture();
    inverted.trajectory.stages[0].endedAt =
      inverted.trajectory.stages[0].startedAt - 1;
    writeFileSync(inverted.filePath, JSON.stringify(inverted.trajectory));
    expect(() => verifyScenarioTrajectories(inverted.input)).toThrow(
      /invalid interval/,
    );
  });
});
