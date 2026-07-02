import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportScenarioNativeJsonl,
  recordedTrajectoryToNativeRows,
  SCENARIO_NATIVE_EXPORT_SCHEMA,
} from "./native-export.ts";

// Synthetic `RecordedTrajectory` shaped like what
// `JsonFileTrajectoryRecorder` writes under <runDir>/trajectories/<agentId>/.
function syntheticTrajectory() {
  return {
    trajectoryId: "tj-test-1",
    agentId: "agent-test",
    roomId: "room-1",
    runId: "run-1",
    scenarioId: "todos.create-basic",
    rootMessage: {
      id: "msg-1",
      text: "add buy milk to my todos",
      sender: "user",
    },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    status: "finished" as const,
    stages: [
      // Tool-search stage: no model call, must be skipped.
      {
        stageId: "stage-search",
        kind: "toolSearch" as const,
        startedAt: 1_700_000_000_100,
        endedAt: 1_700_000_000_200,
        latencyMs: 100,
        toolSearch: {
          query: { text: "add buy milk" },
          results: [],
          tier: { tierA: [], tierB: [], omitted: 0 },
          durationMs: 100,
        },
      },
      // Planner model call: becomes one eliza_native_v1 row with a tool call.
      {
        stageId: "stage-planner",
        kind: "planner" as const,
        iteration: 1,
        startedAt: 1_700_000_000_300,
        endedAt: 1_700_000_000_800,
        latencyMs: 500,
        model: {
          modelType: "TEXT_LARGE",
          modelName: "groq/llama-3.3-70b",
          provider: "groq",
          messages: [
            { role: "system", content: "You are an assistant." },
            { role: "user", content: "add buy milk to my todos" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "CREATE_TODO",
                description: "create a todo",
                parameters: {},
              },
            },
          ],
          toolChoice: "auto",
          response: "Added it.",
          toolCalls: [
            { id: "call_0", name: "CREATE_TODO", args: { text: "buy milk" } },
          ],
          usage: { promptTokens: 120, completionTokens: 14, totalTokens: 134 },
          finishReason: "tool_calls",
          costUsd: 0,
        },
      },
      // Tool execution stage: no model call, must be skipped.
      {
        stageId: "stage-tool",
        kind: "tool" as const,
        startedAt: 1_700_000_000_900,
        endedAt: 1_700_000_000_950,
        latencyMs: 50,
        tool: {
          name: "CREATE_TODO",
          args: { text: "buy milk" },
          result: { ok: true },
          success: true,
          durationMs: 50,
        },
      },
    ],
    metrics: {
      totalLatencyMs: 1000,
      totalPromptTokens: 120,
      totalCompletionTokens: 14,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0,
      plannerIterations: 1,
      toolCallsExecuted: 1,
      toolCallFailures: 0,
      toolSearchCount: 1,
      evaluatorFailures: 0,
      finalDecision: "FINISH" as const,
    },
  };
}

function expectSingleNativeRow(
  rows: ReturnType<typeof recordedTrajectoryToNativeRows>,
) {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toBeDefined();
  if (!row) {
    throw new Error("expected one native export row");
  }
  return row;
}

describe("recordedTrajectoryToNativeRows scenario outcome", () => {
  it("omits scenario outcome fields when no outcome is supplied", () => {
    const rows = recordedTrajectoryToNativeRows(syntheticTrajectory() as never);
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "status")).toBe(false);
    expect(row.scenarioStatus).toBeUndefined();
    expect(row.metadata.scenario_status).toBeUndefined();
  });

  it("stamps a passing scenario outcome on each row", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "passed",
    );
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "status")).toBe(false);
    expect(row.scenarioStatus).toBe("passed");
    expect(row.metadata.scenario_status).toBe("passed");
  });

  it("stamps scenarioStatus='failed' so a failed scenario row is not scored gold", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "failed",
    );
    // The downstream scorer (native_success_and_score) treats scenarioStatus or
    // metadata.scenario_status in {failed,skipped} as success=False/score=0 →
    // rating="repair"/weight=0. Top-level status remains reserved for the
    // canonical native lifecycle contract.
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "status")).toBe(false);
    expect(row.scenarioStatus).toBe("failed");
    expect(row.metadata.trajectory_status).toBe("finished");
    expect(row.metadata.scenario_status).toBe("failed");
  });
});

describe("recordedTrajectoryToNativeRows", () => {
  it("emits one eliza_native_v1 boundary row per model-call stage", () => {
    const rows = recordedTrajectoryToNativeRows(syntheticTrajectory() as never);
    const row = expectSingleNativeRow(rows);
    expect(row.format).toBe("eliza_native_v1");
    expect(row.schemaVersion).toBe(1);
    expect(row.boundary).toBe("vercel_ai_sdk.generateText");
    // request has at least one user turn
    expect(Array.isArray(row.request.messages)).toBe(true);
    expect(
      (row.request.messages as Array<{ role?: string }>).some(
        (m) => m.role === "user",
      ),
    ).toBe(true);
    expect(row.request.tools).toBeDefined();
    // response has either text or toolCalls
    expect(row.response.text).toBe("Added it.");
    expect(row.response.toolCalls).toEqual([
      {
        toolCallId: "call_0",
        toolName: "CREATE_TODO",
        input: { text: "buy milk" },
      },
    ]);
    expect(row.response.finishReason).toBe("tool_calls");
    expect(row.response.usage).toEqual({
      promptTokens: 120,
      completionTokens: 14,
      totalTokens: 134,
    });
    // identity / bookkeeping
    expect(row.trajectoryId).toBe("tj-test-1");
    expect(row.agentId).toBe("agent-test");
    expect(row.scenarioId).toBe("todos.create-basic");
    expect(row.stepId).toBe("stage-planner");
    expect(row.callId).toBe("tj-test-1:stage-planner");
    expect(row.stepIndex).toBe(1);
    expect(row.callIndex).toBe(0);
    expect(row.provider).toBe("groq");
    expect(row.metadata.task_type).toBe("action_planner");
    expect(row.metadata.source_dataset).toBe("scenario_trajectory_boundary");
    expect(row.metadata.scenario_id).toBe("todos.create-basic");
    expect(row.metadata.source_run_id).toBe("run-1");
  });

  it("preserves LifeOps task/domain buckets for scenario model-call prompts", () => {
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: Array<Record<string, unknown>>;
    };
    traj.scenarioId = "lifeops.calendar-extract";
    traj.stages = [
      {
        stageId: "stage-calendar-extract",
        kind: "planner",
        startedAt: 1_700_000_000_300,
        endedAt: 1_700_000_000_800,
        latencyMs: 500,
        model: {
          modelType: "TEXT_SMALL",
          modelName: "test-model",
          provider: "test",
          prompt:
            "Plan the calendar action for this request.\nCurrent request:\nSchedule lunch tomorrow.",
          response:
            '{"subaction":"create_event","shouldAct":true,"queries":[],"title":"Lunch"}',
          usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
          finishReason: "stop",
        },
      },
    ];

    const row = expectSingleNativeRow(
      recordedTrajectoryToNativeRows(traj as never),
    );
    expect(row.metadata.task_type).toBe("calendar_extract");
    expect(row.metadata.domain).toBe("lifeops");
  });

  it("preserves LifeOps task/domain buckets from optimized-prompt purposes", () => {
    const taskKinds = [
      "schedule_plan",
      "reminder_dispatch",
      "inbox_triage",
      "meeting_prep",
      "morning_brief",
    ];
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: Array<Record<string, unknown>>;
    };
    traj.scenarioId = "lifeops.capability-purpose-smoke";
    traj.stages = taskKinds.map((kind, index) => ({
      stageId: `stage-${kind}`,
      kind,
      startedAt: 1_700_000_000_300 + index,
      endedAt: 1_700_000_000_800 + index,
      latencyMs: 500,
      model: {
        modelType: "TEXT_SMALL",
        modelName: "test-model",
        provider: "test",
        prompt: `Capability prompt for ${kind}.`,
        response: `{"ok":true,"task":"${kind}"}`,
        usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
        finishReason: "stop",
      },
    }));

    const rows = recordedTrajectoryToNativeRows(traj as never);
    expect(rows.map((row) => row.metadata.task_type)).toEqual(taskKinds);
    expect(new Set(rows.map((row) => row.metadata.domain))).toEqual(
      new Set(["lifeops"]),
    );
  });

  it("preserves orchestrator goal-verification task/domain buckets", () => {
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: Array<Record<string, unknown>>;
    };
    traj.scenarioId = "orchestrator.grilling-happy-path";
    traj.stages = [
      {
        stageId: "stage-goal-verify",
        kind: "evaluation",
        startedAt: 1_700_000_000_300,
        endedAt: 1_700_000_000_800,
        latencyMs: 500,
        model: {
          modelType: "TEXT_SMALL",
          modelName: "test-model",
          provider: "test",
          prompt: [
            "You are a demanding engineering manager doing final sign-off on a coding sub-agent's work before the parent agent marks the task done.",
            "Acceptance criteria (each must hold for the task to pass):",
            "Completion evidence collected for the sub-agent (git diffstat/changeset, deliverable + final reply, verified URLs, test/build/typecheck output, artifact references):",
          ].join("\n"),
          response:
            '{"passed":false,"summary":"Need proof.","missing":["tests pass with pasted output"]}',
          usage: { promptTokens: 80, completionTokens: 12, totalTokens: 92 },
          finishReason: "stop",
        },
      },
    ];

    const row = expectSingleNativeRow(
      recordedTrajectoryToNativeRows(traj as never),
    );
    expect(row.metadata.task_type).toBe("goal_verification");
    expect(row.metadata.domain).toBe("agent-orchestrator");
  });

  it("skips stages without a usable request/response", () => {
    const traj = syntheticTrajectory() as Record<string, unknown> & {
      stages: unknown[];
    };
    traj.stages = [
      {
        stageId: "stage-empty",
        kind: "planner",
        startedAt: 1,
        endedAt: 2,
        latencyMs: 1,
        model: { modelType: "TEXT_LARGE", provider: "groq", response: "" },
      },
    ];
    expect(recordedTrajectoryToNativeRows(traj as never)).toHaveLength(0);
  });

  it("matches the minimal accepted shape from CANONICAL_RECORD.md", () => {
    const NATIVE_BOUNDARIES = new Set([
      "vercel_ai_sdk.generateText",
      "vercel_ai_sdk.streamText",
    ]);
    for (const row of recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
    )) {
      expect(row.format).toBe("eliza_native_v1");
      expect(NATIVE_BOUNDARIES.has(row.boundary)).toBe(true);
      const hasRequest =
        (Array.isArray(row.request.messages) &&
          (row.request.messages as Array<{ role?: string }>).some(
            (m) => m.role === "user",
          )) ||
        (typeof row.request.prompt === "string" &&
          row.request.prompt.length > 0);
      expect(hasRequest).toBe(true);
      const hasResponse =
        (typeof row.response.text === "string" &&
          row.response.text.trim().length > 0) ||
        (Array.isArray(row.response.toolCalls) &&
          row.response.toolCalls.length > 0);
      expect(hasResponse).toBe(true);
    }
  });
});

describe("exportScenarioNativeJsonl", () => {
  it("walks <runDir>/trajectories and writes JSONL, ignoring junk files", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      // A non-trajectory JSON and an unparseable file should be skipped, not fatal.
      writeFileSync(
        path.join(runDir, "trajectories", "matrix.json"),
        JSON.stringify({ totals: {} }),
        "utf-8",
      );
      writeFileSync(path.join(trajDir, "broken.json"), "{not json", "utf-8");

      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(runDir, outPath);
      expect(count).toBe(1);
      const lines = readFileSync(outPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toBeDefined();
      if (!line) {
        throw new Error("expected one native JSONL line");
      }
      const parsed = JSON.parse(line);
      expect(parsed.format).toBe("eliza_native_v1");
      expect(parsed.metadata.source_dataset).toBe(
        "scenario_trajectory_boundary",
      );
      const manifest = JSON.parse(
        readFileSync(path.join(runDir, "native.manifest.json"), "utf-8"),
      );
      expect(manifest).toMatchObject({
        schema: SCENARIO_NATIVE_EXPORT_SCHEMA,
        runDir,
        jsonlPath: outPath,
        counts: {
          trajectoryFiles: 3,
          parsedTrajectories: 1,
          skippedFiles: 2,
          rows: 1,
        },
        runIds: ["run-1"],
        scenarioIds: ["todos.create-basic"],
        agentIds: ["agent-test"],
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("threads scenario outcomes so failed trajectories carry scenarioStatus='failed'", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-outcome-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      // The scenario mechanically finished (recorder status "finished") but
      // failed its assertions.
      const outcomes = new Map<string, "passed" | "failed" | "skipped">([
        ["todos.create-basic", "failed"],
      ]);
      const count = exportScenarioNativeJsonl(runDir, outPath, outcomes);
      expect(count).toBe(1);
      const parsed = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(parsed.status).toBeUndefined();
      expect(parsed.scenarioStatus).toBe("failed");
      expect(parsed.metadata.scenario_status).toBe("failed");
      expect(parsed.metadata.trajectory_status).toBe("finished");
      const manifest = JSON.parse(
        readFileSync(path.join(runDir, "native.manifest.json"), "utf-8"),
      );
      expect(manifest.counts).toMatchObject({
        rows: 1,
        passedRows: 0,
        failedRows: 1,
        unknownOutcomeRows: 0,
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("writes an empty file when there are no trajectories", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-empty-"));
    try {
      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(runDir, outPath);
      expect(count).toBe(0);
      expect(readFileSync(outPath, "utf-8")).toBe("");
      const manifest = JSON.parse(
        readFileSync(path.join(runDir, "native.manifest.json"), "utf-8"),
      );
      expect(manifest.counts).toMatchObject({
        trajectoryFiles: 0,
        parsedTrajectories: 0,
        skippedFiles: 0,
        rows: 0,
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("judge score serialization (#8795)", () => {
  it("stamps the numeric judge score on rows and metadata", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "passed",
      0.82,
    );
    const row = expectSingleNativeRow(rows);
    expect(row.judgeScore).toBe(0.82);
    expect(row.metadata.judge_score).toBe(0.82);
    // Survives JSON round-tripping as a number, not a detail string.
    const parsed = JSON.parse(JSON.stringify(row));
    expect(parsed.judgeScore).toBe(0.82);
    expect(parsed.metadata.judge_score).toBe(0.82);
  });

  it("omits judge score fields when no judge ran", () => {
    const rows = recordedTrajectoryToNativeRows(
      syntheticTrajectory() as never,
      "passed",
    );
    const row = expectSingleNativeRow(rows);
    expect(Object.hasOwn(row, "judgeScore")).toBe(false);
    expect(Object.hasOwn(row.metadata, "judge_score")).toBe(false);
  });

  it("threads per-scenario judge scores through exportScenarioNativeJsonl", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-judge-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      const outcomes = new Map<string, "passed" | "failed" | "skipped">([
        ["todos.create-basic", "passed"],
      ]);
      const judgeScores = new Map<string, number>([
        ["todos.create-basic", 0.9],
      ]);
      const count = exportScenarioNativeJsonl(
        runDir,
        outPath,
        outcomes,
        judgeScores,
      );
      expect(count).toBe(1);
      const parsed = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(parsed.scenarioStatus).toBe("passed");
      expect(parsed.judgeScore).toBe(0.9);
      expect(parsed.metadata.judge_score).toBe(0.9);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("leaves rows for unjudged scenarios untouched", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-native-nojudge-"));
    try {
      const trajDir = path.join(runDir, "trajectories", "agent-test");
      mkdirSync(trajDir, { recursive: true });
      writeFileSync(
        path.join(trajDir, "tj-test-1.json"),
        JSON.stringify(syntheticTrajectory()),
        "utf-8",
      );
      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(
        runDir,
        outPath,
        new Map([["todos.create-basic", "passed" as const]]),
        new Map<string, number>([["some.other-scenario", 0.5]]),
      );
      expect(count).toBe(1);
      const parsed = JSON.parse(readFileSync(outPath, "utf-8").trim());
      expect(parsed.judgeScore).toBeUndefined();
      expect(parsed.metadata.judge_score).toBeUndefined();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
