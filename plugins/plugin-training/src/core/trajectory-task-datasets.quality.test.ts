/**
 * Quality gate for optimization datasets (#8795).
 *
 * Before the fix, `buildExampleForTask` cloned every recorded response as
 * gold-weight supervision — a trajectory from a FAILED scenario trained
 * identically to a passed one (behavior cloning of failures). These tests
 * prove:
 *
 *   - a failed/skipped-scenario trajectory is excluded from every dataset
 *     bucket (object path and native-JSONL path),
 *   - a passed trajectory keeps full weight,
 *   - the exclusion is counted in the export summary,
 *   - the quality-signal helpers read both metadata locations and derive the
 *     reward exactly (judge score wins, passed → 1, no signal → undefined).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { ELIZA_NATIVE_TRAJECTORY_FORMAT } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportTrajectoryTaskDatasets,
  extractTrajectoryExamplesByTask,
  isFailedScenarioSignal,
  qualitySignalForRowMetadata,
  rewardForQualitySignal,
} from "./trajectory-task-datasets.js";

const trajectoryWithOutcome = (
  id: string,
  metadata: Record<string, unknown> | undefined,
): Trajectory => ({
  trajectoryId: id,
  agentId: "agent-1",
  startTime: 1,
  metadata,
  steps: [
    {
      stepId: "step-1",
      timestamp: 1,
      llmCalls: [
        {
          callId: `${id}-call-1`,
          purpose: "calendar_extract",
          systemPrompt: "Extract structured LifeOps output.",
          userPrompt: "schedule lunch with Dana tomorrow at noon",
          response: JSON.stringify({ title: "Lunch with Dana" }),
        },
      ],
    },
  ],
});

const nativeRow = (
  callId: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> => ({
  format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
  schemaVersion: 1,
  boundary: "vercel_ai_sdk.generateText",
  trajectoryId: "traj-native",
  agentId: "agent-1",
  source: "scenario",
  status: "completed",
  stepId: "step-1",
  stepIndex: 0,
  timestamp: 1,
  callId,
  callIndex: 0,
  purpose: "calendar_extract",
  request: {
    prompt: "schedule lunch",
    messages: [
      { role: "system", content: "Extract the event." },
      { role: "user", content: "schedule lunch" },
    ],
  },
  response: { text: JSON.stringify({ title: "Lunch" }) },
  metadata: {
    task_type: "calendar_extract",
    source_dataset: "scenario_trajectory_boundary",
    trajectory_id: "traj-native",
    call_id: callId,
    agent_id: "agent-1",
    ...metadata,
  },
});

describe("quality signal helpers", () => {
  it("reads scenario_status and judge_score from direct metadata keys", () => {
    const signal = qualitySignalForRowMetadata({
      scenario_status: "passed",
      judge_score: 0.85,
    });
    expect(signal).toEqual({ scenarioStatus: "passed", judgeScore: 0.85 });
  });

  it("falls back to the nested trajectory_metadata bag", () => {
    const signal = qualitySignalForRowMetadata({
      trajectory_metadata: { scenario_status: "failed", judge_score: 0.2 },
    });
    expect(signal).toEqual({ scenarioStatus: "failed", judgeScore: 0.2 });
  });

  it("prefers direct keys over the nested bag and clamps scores to [0,1]", () => {
    const signal = qualitySignalForRowMetadata({
      judge_score: 3,
      trajectory_metadata: { scenario_status: "passed", judge_score: 0.1 },
    });
    expect(signal).toEqual({ scenarioStatus: "passed", judgeScore: 1 });
  });

  it("ignores malformed values", () => {
    expect(
      qualitySignalForRowMetadata({
        scenario_status: "sorta",
        judge_score: "high",
      }),
    ).toEqual({});
    expect(qualitySignalForRowMetadata(undefined)).toEqual({});
  });

  it("derives the reward: judge score wins, passed → 1, no signal → undefined", () => {
    expect(
      rewardForQualitySignal({ scenarioStatus: "passed", judgeScore: 0.6 }),
    ).toBe(0.6);
    expect(rewardForQualitySignal({ scenarioStatus: "passed" })).toBe(1);
    expect(rewardForQualitySignal({})).toBeUndefined();
  });

  it("flags failed and skipped scenarios, not passed or unknown", () => {
    expect(isFailedScenarioSignal({ scenarioStatus: "failed" })).toBe(true);
    expect(isFailedScenarioSignal({ scenarioStatus: "skipped" })).toBe(true);
    expect(isFailedScenarioSignal({ scenarioStatus: "passed" })).toBe(false);
    expect(isFailedScenarioSignal({})).toBe(false);
  });
});

describe("failed-scenario exclusion (trajectory object path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("excludes a failed-scenario trajectory wholesale", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const examples = extractTrajectoryExamplesByTask(
      [
        trajectoryWithOutcome("traj-failed", { scenario_status: "failed" }),
        trajectoryWithOutcome("traj-passed", { scenario_status: "passed" }),
      ],
      ["calendar_extract"],
    );
    expect(examples.calendar_extract).toHaveLength(1);
    expect(examples.calendar_extract[0]?.trajectoryId).toBe("traj-passed");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("excluded trajectory traj-failed"),
    );
  });

  it("excludes a skipped-scenario trajectory too", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const examples = extractTrajectoryExamplesByTask(
      [trajectoryWithOutcome("traj-skipped", { scenario_status: "skipped" })],
      ["calendar_extract"],
    );
    expect(examples.calendar_extract).toHaveLength(0);
  });

  it("keeps a trajectory with no outcome metadata (no signal ≠ failed)", () => {
    const examples = extractTrajectoryExamplesByTask(
      [trajectoryWithOutcome("traj-unknown", undefined)],
      ["calendar_extract"],
    );
    expect(examples.calendar_extract).toHaveLength(1);
  });

  it("counts the exclusion in the export summary", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const outputDir = await mkdtemp(join(tmpdir(), "trajectory-quality-"));
    try {
      const exported = await exportTrajectoryTaskDatasets(
        [
          trajectoryWithOutcome("traj-failed", { scenario_status: "failed" }),
          trajectoryWithOutcome("traj-passed", { scenario_status: "passed" }),
        ],
        outputDir,
        ["calendar_extract"],
      );
      expect(exported.summary.excludedFailedScenarioRows).toBe(1);
      expect(exported.counts.calendar_extract).toBe(1);
      const persisted = JSON.parse(
        await readFile(exported.paths.summaryPath, "utf8"),
      ) as { excludedFailedScenarioRows: number };
      expect(persisted.excludedFailedScenarioRows).toBe(1);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe("failed-scenario exclusion (native JSONL path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("excludes failed rows and keeps passed rows from export text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exportText = `${[
      nativeRow("call-failed", { scenario_status: "failed" }),
      nativeRow("call-passed", { scenario_status: "passed" }),
      nativeRow("call-unknown", {}),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`;
    const examples = extractTrajectoryExamplesByTask(exportText, [
      "calendar_extract",
    ]);
    expect(examples.calendar_extract.map((row) => row.callId)).toEqual([
      "call-passed",
      "call-unknown",
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("scenario_status=failed"),
    );
  });

  it("excludes rows whose outcome only lives in trajectory_metadata", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const exportText = `${JSON.stringify(
      nativeRow("call-nested-failed", {
        trajectory_metadata: { scenario_status: "failed" },
      }),
    )}\n`;
    const examples = extractTrajectoryExamplesByTask(exportText, [
      "calendar_extract",
    ]);
    expect(examples.calendar_extract).toHaveLength(0);
  });
});
