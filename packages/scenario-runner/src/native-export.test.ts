import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportScenarioNativeJsonl,
  recordedTrajectoryToNativeRows,
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
    rootMessage: { id: "msg-1", text: "add buy milk to my todos", sender: "user" },
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
              function: { name: "CREATE_TODO", description: "create a todo", parameters: {} },
            },
          ],
          toolChoice: "auto",
          response: "Added it.",
          toolCalls: [{ id: "call_0", name: "CREATE_TODO", args: { text: "buy milk" } }],
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
        tool: { name: "CREATE_TODO", args: { text: "buy milk" }, result: { ok: true }, success: true, durationMs: 50 },
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

describe("recordedTrajectoryToNativeRows", () => {
  it("emits one eliza_native_v1 boundary row per model-call stage", () => {
    const rows = recordedTrajectoryToNativeRows(syntheticTrajectory() as never);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.format).toBe("eliza_native_v1");
    expect(row.schemaVersion).toBe(1);
    expect(row.boundary).toBe("vercel_ai_sdk.generateText");
    // request has at least one user turn
    expect(Array.isArray(row.request.messages)).toBe(true);
    expect(
      (row.request.messages as Array<{ role?: string }>).some((m) => m.role === "user"),
    ).toBe(true);
    expect(row.request.tools).toBeDefined();
    // response has either text or toolCalls
    expect(row.response.text).toBe("Added it.");
    expect(row.response.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: "CREATE_TODO", input: { text: "buy milk" } },
    ]);
    expect(row.response.finishReason).toBe("tool_calls");
    expect(row.response.usage).toEqual({ promptTokens: 120, completionTokens: 14, totalTokens: 134 });
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

  it("skips stages without a usable request/response", () => {
    const traj = syntheticTrajectory() as Record<string, unknown> & { stages: unknown[] };
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
    const NATIVE_BOUNDARIES = new Set(["vercel_ai_sdk.generateText", "vercel_ai_sdk.streamText"]);
    for (const row of recordedTrajectoryToNativeRows(syntheticTrajectory() as never)) {
      expect(row.format).toBe("eliza_native_v1");
      expect(NATIVE_BOUNDARIES.has(row.boundary)).toBe(true);
      const hasRequest =
        (Array.isArray(row.request.messages) &&
          (row.request.messages as Array<{ role?: string }>).some((m) => m.role === "user")) ||
        (typeof row.request.prompt === "string" && row.request.prompt.length > 0);
      expect(hasRequest).toBe(true);
      const hasResponse =
        (typeof row.response.text === "string" && row.response.text.trim().length > 0) ||
        (Array.isArray(row.response.toolCalls) && row.response.toolCalls.length > 0);
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
      writeFileSync(path.join(runDir, "trajectories", "matrix.json"), JSON.stringify({ totals: {} }), "utf-8");
      writeFileSync(path.join(trajDir, "broken.json"), "{not json", "utf-8");

      const outPath = path.join(runDir, "native.jsonl");
      const count = exportScenarioNativeJsonl(runDir, outPath);
      expect(count).toBe(1);
      const lines = readFileSync(outPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.format).toBe("eliza_native_v1");
      expect(parsed.metadata.source_dataset).toBe("scenario_trajectory_boundary");
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
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
