import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { computeCallCostUsd } from "../lib/cost-table";
import {
  compareTrajectories,
  type RecordedStage,
  type RecordedTrajectory,
  validateTrajectory,
  validateTrajectoryJsonReport,
  validateTrajectoryMarkdownReport,
} from "../lib/trajectory-validate";

async function readScenario(name: string): Promise<{
  expect: { stages?: string[]; contexts?: string[]; tools?: string[] };
}> {
  const raw = await fs.readFile(
    path.join(
      process.cwd(),
      "research/native-tool-calling/scenarios",
      `${name}.json`,
    ),
    "utf8",
  );
  return JSON.parse(raw);
}

function modelStage(args: {
  stageId: string;
  kind: "messageHandler" | "planner" | "evaluation";
  startedAt: number;
  endedAt: number;
  prompt: string;
  response: string;
  tools?: Array<{ name: string; description: string }>;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    totalTokens: number;
  };
  evaluation?: { success: boolean; decision: string; thought?: string };
  iteration?: number;
  cache?: RecordedStage["cache"];
}): RecordedStage {
  return {
    stageId: args.stageId,
    kind: args.kind,
    iteration: args.iteration,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    latencyMs: args.endedAt - args.startedAt,
    model: {
      modelType:
        args.kind === "planner" ? "ACTION_PLANNER" : "RESPONSE_HANDLER",
      modelName: "gpt-oss-120b",
      provider: "cerebras",
      prompt: args.prompt,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "search for 'eliza'" },
      ],
      tools: args.tools ?? [],
      toolCalls: args.toolCalls ?? [],
      response: args.response,
      usage: args.usage,
      costUsd: computeCallCostUsd("gpt-oss-120b", args.usage),
    },
    evaluation: args.evaluation,
    cache: args.cache,
  };
}

function completeTrajectory(
  overrides: Partial<RecordedTrajectory> = {},
): RecordedTrajectory {
  const stages: RecordedStage[] = [
    modelStage({
      stageId: "stage-msghandler-1",
      kind: "messageHandler",
      startedAt: 1_000,
      endedAt: 1_100,
      prompt:
        "available_contexts:\n- web: Search the web.\ncontextRegistryDigest: abc",
      response: JSON.stringify({
        action: "RESPOND",
        simple: false,
        contexts: ["web"],
        thought: "Need web search.",
      }),
      usage: {
        promptTokens: 1000,
        completionTokens: 50,
        totalTokens: 1050,
      },
    }),
    modelStage({
      stageId: "stage-planner-1",
      kind: "planner",
      iteration: 1,
      startedAt: 1_110,
      endedAt: 1_260,
      prompt:
        'selected_contexts: web\n{"contextDefinitions":[{"id":"web"}],"contextProviders":[{"label":"web results"}],"expandedTools":[{"name":"WEB_SEARCH"}]}',
      response: "",
      tools: [{ name: "WEB_SEARCH", description: "Search the web" }],
      toolCalls: [{ id: "call-1", name: "WEB_SEARCH", args: { q: "eliza" } }],
      usage: {
        promptTokens: 1500,
        completionTokens: 80,
        cacheReadInputTokens: 500,
        totalTokens: 1580,
      },
      cache: {
        segmentHashes: ["a", "b"],
        prefixHash: "ab",
        diffFromPriorStage: { added: 2, unchanged: 0, removed: 0 },
      },
    }),
    {
      stageId: "stage-tool-1",
      kind: "tool",
      startedAt: 1_270,
      endedAt: 1_300,
      latencyMs: 30,
      tool: {
        name: "WEB_SEARCH",
        args: { q: "eliza" },
        result: { hits: [{ title: "Eliza", url: "https://example.test" }] },
        success: true,
        durationMs: 30,
      },
    },
    modelStage({
      stageId: "stage-eval-1",
      kind: "evaluation",
      iteration: 1,
      startedAt: 1_310,
      endedAt: 1_390,
      prompt:
        'selected_contexts: web\n{"contextProviders":[{"label":"tool result"}]}',
      response: JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Done.",
      }),
      usage: {
        promptTokens: 1700,
        completionTokens: 40,
        cacheReadInputTokens: 1000,
        totalTokens: 1740,
      },
      evaluation: { success: true, decision: "FINISH", thought: "Done." },
    }),
  ];
  const totalCostUsd = stages.reduce(
    (sum, stage) => sum + (stage.model?.costUsd ?? 0),
    0,
  );
  return {
    trajectoryId: "tj-fixture",
    agentId: "agent-fixture",
    roomId: "room-fixture",
    rootMessage: { id: "msg-1", text: "search for 'eliza'", sender: "user" },
    startedAt: 1_000,
    endedAt: 1_390,
    status: "finished",
    stages,
    metrics: {
      totalLatencyMs: 360,
      totalPromptTokens: 4200,
      totalCompletionTokens: 170,
      totalCacheReadTokens: 1500,
      totalCacheCreationTokens: 0,
      totalCostUsd,
      plannerIterations: 1,
      toolCallsExecuted: 1,
      toolCallFailures: 0,
      evaluatorFailures: 0,
      finalDecision: "FINISH",
    },
    ...overrides,
  };
}

describe("trajectory structural validation", () => {
  test("accepts a complete trajectory and scenario stage expectations", async () => {
    const scenario = await readScenario("single-tool");
    const result = validateTrajectory(completeTrajectory(), {
      expectedStages: scenario.expect.stages,
      expectedContexts: ["web"],
      requireMessageArrays: true,
    });

    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.selectedContexts).toEqual(["web"]);
    expect(result.rollup.toolResultSuccesses).toBe(1);
    expect(result.rollup.evaluatorSuccesses).toBe(1);
    expect(result.rollup.totalCacheReadTokens).toBe(1500);
  });

  test("rejects missing full prompt/messages/tools/toolCalls and bad rollups", () => {
    const broken = completeTrajectory();
    delete broken.stages[1]?.model?.messages;
    delete broken.stages[1]?.model?.tools;
    delete broken.stages[1]?.model?.toolCalls;
    const planner = broken.stages[1];
    if (planner?.model) planner.model.prompt = "";
    broken.metrics.totalCacheReadTokens = 1;

    const result = validateTrajectory(broken, { requireMessageArrays: true });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain(
      "$.stages[1].model.prompt",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "$.stages[1].model.messages",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "$.stages[1].model.tools",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "$.stages[1].model.toolCalls",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "$.metrics.totalCacheReadTokens",
    );
  });

  test("validates JSON and markdown exports", () => {
    const trajectory = completeTrajectory();
    const json = validateTrajectoryJsonReport(JSON.stringify(trajectory));
    expect(json.ok).toBe(true);

    const markdown = [
      "# Trajectory tj-fixture",
      "- root message: search for 'eliza'",
      "## Stage 1: messageHandler (stage-msghandler-1)",
      "PROMPT:",
      "RESPONSE:",
      "MESSAGES:",
      "TOOLS:",
      "TOOL_CALLS:",
      "## Stage 2: planner iter 1 (stage-planner-1)",
      "PROMPT:",
      "RESPONSE:",
      "MESSAGES:",
      "TOOLS:",
      "TOOL_CALLS:",
      "## Stage 3: tool (stage-tool-1)",
      "tool `WEB_SEARCH` ok",
      "## Stage 4: evaluation iter 1 (stage-eval-1)",
      "PROMPT:",
      "RESPONSE:",
      "MESSAGES:",
      "TOOLS:",
      "TOOL_CALLS:",
      "evaluation:",
    ].join("\n");
    const md = validateTrajectoryMarkdownReport(markdown, trajectory);
    expect(md.ok).toBe(true);
  });

  test("compares cache, batching, and cost deltas", () => {
    const a = completeTrajectory();
    const b = completeTrajectory({
      trajectoryId: "tj-fixture-b",
      stages: completeTrajectory().stages.slice(0, 3),
      metrics: {
        ...completeTrajectory().metrics,
        totalLatencyMs: 280,
        totalPromptTokens: 2500,
        totalCompletionTokens: 130,
        totalCacheReadTokens: 500,
        totalCostUsd:
          (completeTrajectory().stages[0]?.model?.costUsd ?? 0) +
          (completeTrajectory().stages[1]?.model?.costUsd ?? 0),
        evaluatorFailures: 0,
      },
    });

    const comparison = compareTrajectories(a, b);
    expect(comparison.delta.modelCallStages).toBe(-1);
    expect(comparison.delta.totalCacheReadTokens).toBe(-1000);
    expect(comparison.estimatedBatchingDelta.stages).toBe(-1);
    expect(comparison.cacheHitRateA).toBeGreaterThan(comparison.cacheHitRateB);
  });
});
