import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRuntime } from "@elizaos/core";
import { flushTrajectoryWrites } from "../../../../packages/agent/src/runtime/trajectory-storage.ts";
import type {
  Trajectory,
  TrajectoryLlmCall,
} from "../../../../packages/agent/src/types/trajectory.ts";
import { ConversationHarness } from "../../../../packages/app-core/test/helpers/conversation-harness.ts";
import {
  type LiveProviderName,
  selectLiveProvider,
} from "../../../../packages/app-core/test/helpers/live-provider.ts";
import type { RealTestRuntimeResult } from "../../../../packages/app-core/test/helpers/real-runtime.ts";
import { actionsAreScenarioEquivalent } from "../../../../packages/scenario-runner/src/action-families.ts";
import type {
  PromptBenchmarkCase,
  PromptBenchmarkRiskClass,
  PromptBenchmarkSuiteId,
  PromptBenchmarkVariantId,
} from "./lifeops-prompt-benchmark-cases.ts";
import { createLifeOpsTestRuntime } from "./runtime.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const PASSIVE_ACTIONS = new Set(["REPLY", "IGNORE", "NONE", "CHOOSE_OPTION"]);

export type PromptBenchmarkResult = {
  case: PromptBenchmarkCase;
  actualPrimaryAction: string | null;
  actualActions: string[];
  pass: boolean;
  latencyMs: number;
  responseText: string;
  error?: string;
  trajectoryId?: string;
  llmCallCount: number;
  plannerPrompt?: string;
  plannerResponse?: string;
  // Per-case token + cache totals summed across every llmCall in the
  // captured trajectory. Cache hit % uses the corrected denominator
  // (input + cache_creation + cache_read) so it matches Anthropic semantics.
  promptTokens?: number;
  completionTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalInputTokens?: number;
  cacheHitPct?: number;
};

export type PromptBenchmarkSliceStats = {
  total: number;
  passed: number;
  accuracy: number;
};

export type PromptBenchmarkLatencyStats = {
  avg: number;
  p50: number;
  p95: number;
};

export type PromptBenchmarkReport = {
  generatedAt: string;
  providerName: string;
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  weightedAccuracy: number;
  falsePositiveRate: number;
  trajectoryCaptureRate: number;
  latency: PromptBenchmarkLatencyStats;
  bySuite: Record<PromptBenchmarkSuiteId, PromptBenchmarkSliceStats>;
  byVariant: Record<PromptBenchmarkVariantId, PromptBenchmarkSliceStats>;
  byRiskClass: Record<PromptBenchmarkRiskClass, PromptBenchmarkSliceStats>;
  failures: PromptBenchmarkResult[];
  results: PromptBenchmarkResult[];
};

export type AxOptimizationRow = {
  id: string;
  suiteId: PromptBenchmarkSuiteId;
  baseScenarioId: string;
  variantId: PromptBenchmarkVariantId;
  prompt: string;
  axes: string[];
  expected: {
    action: string | null;
    acceptableActions: string[];
    forbiddenActions: string[];
    operation: string | null;
  };
  observed: {
    action: string | null;
    actions: string[];
    responseText: string;
    plannerPrompt?: string;
    plannerResponse?: string;
    trajectoryId?: string;
  };
  metrics: {
    pass: boolean;
    latencyMs: number;
    llmCallCount: number;
    benchmarkWeight: number;
  };
};

type TrajectoryServiceLike = {
  listTrajectories: (options?: { limit?: number; offset?: number }) => Promise<{
    trajectories?: Array<{
      id?: string;
      startTime?: number;
    }>;
  }>;
  getTrajectoryDetail: (trajectoryId: string) => Promise<Trajectory | null>;
};

type RunOptions = {
  cases: PromptBenchmarkCase[];
  isolate?: "shared" | "per-case";
  preferredProvider?: LiveProviderName;
  runtime?: AgentRuntime;
  timeoutMsPerCase?: number;
};

function normalizeActionName(
  actionName: string | null | undefined,
): string | null {
  const normalized = String(actionName ?? "")
    .trim()
    .toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function llmCallMatchesPrompt(
  llmCall: TrajectoryLlmCall,
  prompt: string,
): boolean {
  const promptText = normalizeComparableText(prompt);
  const userPrompt = normalizeComparableText(String(llmCall.userPrompt ?? ""));
  if (!promptText || !userPrompt) {
    return false;
  }
  return userPrompt.includes(promptText) || promptText.includes(userPrompt);
}

function collectLlmCalls(detail: Trajectory | null): TrajectoryLlmCall[] {
  if (!detail?.steps?.length) {
    return [];
  }
  return detail.steps.flatMap((step) => step.llmCalls ?? []);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function resolveTrajectoryService(
  runtime: AgentRuntime,
): TrajectoryServiceLike | null {
  const runtimeWithServices = runtime as AgentRuntime & {
    getService?: (name: string) => unknown;
    getServicesByType?: (name: string) => unknown;
  };

  const candidates: unknown[] = [];
  if (typeof runtimeWithServices.getServicesByType === "function") {
    const value = runtimeWithServices.getServicesByType("trajectories");
    if (Array.isArray(value)) {
      candidates.push(...value);
    } else if (value) {
      candidates.push(value);
    }
  }
  if (typeof runtimeWithServices.getService === "function") {
    candidates.push(runtimeWithServices.getService("trajectories"));
  }

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "listTrajectories" in candidate &&
      "getTrajectoryDetail" in candidate
    ) {
      return candidate as TrajectoryServiceLike;
    }
  }

  return null;
}

async function captureTrajectoryForCase(args: {
  prompt: string;
  runtime: AgentRuntime;
  startedAtMs: number;
}): Promise<{
  trajectoryId?: string;
  plannerPrompt?: string;
  plannerResponse?: string;
  llmCallCount: number;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalInputTokens?: number;
  cacheHitPct?: number;
}> {
  const service = resolveTrajectoryService(args.runtime);
  if (!service) {
    return { llmCallCount: 0 };
  }

  await flushTrajectoryWrites(args.runtime);
  await sleep(50);

  const list = await service.listTrajectories({ limit: 8 });
  const candidates = (list.trajectories ?? [])
    .filter((entry) => Number(entry.startTime ?? 0) >= args.startedAtMs - 2_000)
    .map((entry) => String(entry.id ?? "").trim())
    .filter(Boolean);
  const trajectoryIds = candidates.length
    ? candidates
    : (list.trajectories ?? [])
        .map((entry) => String(entry.id ?? "").trim())
        .filter(Boolean)
        .slice(0, 3);

  let bestDetail: Trajectory | null = null;
  for (const trajectoryId of trajectoryIds) {
    const detail = await service.getTrajectoryDetail(trajectoryId);
    if (!detail) {
      continue;
    }
    const llmCalls = collectLlmCalls(detail);
    if (
      llmCalls.some((llmCall) => llmCallMatchesPrompt(llmCall, args.prompt))
    ) {
      bestDetail = detail;
      break;
    }
    if (!bestDetail) {
      bestDetail = detail;
    }
  }

  const llmCalls = collectLlmCalls(bestDetail);
  const latestCall = llmCalls[llmCalls.length - 1];

  // Sum token + cache fields across every llmCall on this trajectory.
  // Cache hit % uses (input + cache_creation + cache_read) as denominator
  // so it agrees with the corrected core formula.
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const c of llmCalls) {
    const cAny = c as Record<string, unknown>;
    promptTokens += Number(cAny.promptTokens ?? cAny.inputTokens ?? 0) || 0;
    completionTokens +=
      Number(cAny.completionTokens ?? cAny.outputTokens ?? 0) || 0;
    cacheRead +=
      Number(cAny.cacheReadInputTokens ?? cAny.cachedInputTokens ?? 0) || 0;
    cacheCreate += Number(cAny.cacheCreationInputTokens ?? 0) || 0;
  }
  const totalInput = promptTokens + cacheRead + cacheCreate;
  const cacheHitPct = totalInput > 0 ? +((cacheRead / totalInput) * 100).toFixed(2) : 0;

  return {
    trajectoryId: bestDetail?.trajectoryId,
    plannerPrompt:
      typeof latestCall?.userPrompt === "string"
        ? latestCall.userPrompt
        : undefined,
    plannerResponse:
      typeof latestCall?.response === "string"
        ? latestCall.response
        : undefined,
    llmCallCount: llmCalls.length,
    promptTokens,
    completionTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    totalInputTokens: totalInput,
    cacheHitPct,
  };
}

function selectPrimaryAction(actions: string[]): string | null {
  const normalized = uniqueStrings(actions).map((actionName) =>
    normalizeActionName(actionName),
  );
  const nonPassive = normalized.filter(
    (actionName): actionName is string =>
      actionName !== null && !PASSIVE_ACTIONS.has(actionName),
  );
  const lastNonPassive = nonPassive[nonPassive.length - 1] ?? null;
  if (lastNonPassive) {
    return lastNonPassive;
  }
  return normalized[normalized.length - 1] ?? null;
}

export function promptBenchmarkCasePasses(
  result: PromptBenchmarkResult,
): boolean {
  const actual = normalizeActionName(result.actualPrimaryAction);
  const actualActions = uniqueStrings(
    result.actualActions.length > 0
      ? result.actualActions
      : result.actualPrimaryAction
        ? [result.actualPrimaryAction]
        : [],
  )
    .map((actionName) => normalizeActionName(actionName))
    .filter((actionName): actionName is string => actionName !== null);
  const expected = normalizeActionName(result.case.expectedAction);
  const acceptable = new Set(
    result.case.acceptableActions
      .map((actionName) => normalizeActionName(actionName))
      .filter((actionName): actionName is string => actionName !== null),
  );
  const forbidden = new Set(
    result.case.forbiddenActions
      .map((actionName) => normalizeActionName(actionName))
      .filter((actionName): actionName is string => actionName !== null),
  );

  if (
    actualActions.some((actionName) =>
      Array.from(forbidden).some((forbiddenAction) =>
        actionsAreScenarioEquivalent(actionName, forbiddenAction),
      ),
    )
  ) {
    return false;
  }

  if (expected === null) {
    return (
      actualActions.length === 0 ||
      actual === null ||
      actualActions.some((actionName) =>
        Array.from(acceptable).some((acceptableAction) =>
          actionsAreScenarioEquivalent(actionName, acceptableAction),
        ),
      )
    );
  }

  return (
    actualActions.some((actionName) =>
      actionsAreScenarioEquivalent(actionName, expected),
    ) ||
    actualActions.some((actionName) =>
      Array.from(acceptable).some((acceptableAction) =>
        actionsAreScenarioEquivalent(actionName, acceptableAction),
      ),
    )
  );
}

async function runSinglePromptBenchmarkCase(args: {
  runtime: AgentRuntime;
  testCase: PromptBenchmarkCase;
  timeoutMs: number;
}): Promise<PromptBenchmarkResult> {
  const harness = new ConversationHarness(args.runtime, {
    userName: "Owner",
    source: "dashboard",
  });

  // Tag every trajectory landed during this case so the aggregator can
  // group per-case JSONL bundles.
  const previousScenarioId = process.env.MILADY_LIFEOPS_SCENARIO_ID;
  process.env.MILADY_LIFEOPS_SCENARIO_ID = args.testCase.caseId;

  try {
    args.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", harness.userId, false);
    await harness.setup();
    const turn = await harness.send(args.testCase.prompt, {
      timeoutMs: args.timeoutMs,
      metadata: {
        benchmarkContext: args.testCase.benchmarkContext,
      },
    });
    const actionNames = uniqueStrings(
      turn.actions
        .filter((action) => action.phase === "completed")
        .map((action) => action.actionName),
    );
    const fallbackActionNames = uniqueStrings(
      turn.actions.map((action) => action.actionName),
    );
    const actualActions = actionNames.length
      ? actionNames
      : fallbackActionNames;
    const trajectory = await captureTrajectoryForCase({
      prompt: args.testCase.prompt,
      runtime: args.runtime,
      startedAtMs: turn.startedAt,
    });

    const provisional = {
      case: args.testCase,
      actualPrimaryAction: selectPrimaryAction(actualActions),
      actualActions,
      latencyMs: turn.durationMs,
      llmCallCount: trajectory.llmCallCount,
      pass: false,
      plannerPrompt: trajectory.plannerPrompt,
      plannerResponse: trajectory.plannerResponse,
      responseText: turn.responseText,
      trajectoryId: trajectory.trajectoryId,
      promptTokens: trajectory.promptTokens,
      completionTokens: trajectory.completionTokens,
      cacheReadInputTokens: trajectory.cacheReadInputTokens,
      cacheCreationInputTokens: trajectory.cacheCreationInputTokens,
      totalInputTokens: trajectory.totalInputTokens,
      cacheHitPct: trajectory.cacheHitPct,
    } satisfies Omit<PromptBenchmarkResult, "pass"> & { pass: boolean };

    return {
      ...provisional,
      pass: promptBenchmarkCasePasses(provisional),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = {
      case: args.testCase,
      actualPrimaryAction: null,
      actualActions: [],
      error: message,
      latencyMs: 0,
      llmCallCount: 0,
      pass: false,
      responseText: "",
    } satisfies PromptBenchmarkResult;
    return failed;
  } finally {
    await harness.cleanup();
    if (previousScenarioId === undefined) {
      delete process.env.MILADY_LIFEOPS_SCENARIO_ID;
    } else {
      process.env.MILADY_LIFEOPS_SCENARIO_ID = previousScenarioId;
    }
  }
}

export function buildPromptBenchmarkReport(args: {
  providerName: string;
  results: PromptBenchmarkResult[];
}): PromptBenchmarkReport {
  const { providerName, results } = args;
  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  const totalWeight = results.reduce(
    (sum, result) => sum + result.case.benchmarkWeight,
    0,
  );
  const passedWeight = results
    .filter((result) => result.pass)
    .reduce((sum, result) => sum + result.case.benchmarkWeight, 0);
  const nullCases = results.filter(
    (result) => result.case.riskClass === "null",
  );
  const nullFalsePositives = nullCases.filter((result) => !result.pass).length;
  const trajectoryHits = results.filter(
    (result) => typeof result.trajectoryId === "string" && result.trajectoryId,
  ).length;

  const bySuite = {} as Record<
    PromptBenchmarkSuiteId,
    PromptBenchmarkSliceStats
  >;
  const byVariant = {} as Record<
    PromptBenchmarkVariantId,
    PromptBenchmarkSliceStats
  >;
  const byRiskClass = {} as Record<
    PromptBenchmarkRiskClass,
    PromptBenchmarkSliceStats
  >;

  for (const result of results) {
    const buckets: Array<[Record<string, PromptBenchmarkSliceStats>, string]> =
      [
        [
          bySuite as Record<string, PromptBenchmarkSliceStats>,
          result.case.suiteId,
        ],
        [
          byVariant as Record<string, PromptBenchmarkSliceStats>,
          result.case.variantId,
        ],
        [
          byRiskClass as Record<string, PromptBenchmarkSliceStats>,
          result.case.riskClass,
        ],
      ];
    for (const [collection, key] of buckets) {
      const bucket = collection[key] ?? { total: 0, passed: 0, accuracy: 0 };
      bucket.total += 1;
      if (result.pass) {
        bucket.passed += 1;
      }
      collection[key] = bucket;
    }
  }

  for (const collection of [bySuite, byVariant, byRiskClass]) {
    for (const key of Object.keys(collection)) {
      const bucket = collection[key as keyof typeof collection];
      if (!bucket) {
        continue;
      }
      bucket.accuracy = bucket.total === 0 ? 0 : bucket.passed / bucket.total;
    }
  }

  const latencies = [...results.map((result) => result.latencyMs)].sort(
    (left, right) => left - right,
  );
  const latencyAvg =
    latencies.length === 0
      ? 0
      : latencies.reduce((sum, latencyMs) => sum + latencyMs, 0) /
        latencies.length;

  return {
    generatedAt: new Date().toISOString(),
    providerName,
    total: results.length,
    passed,
    failed,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    weightedAccuracy: totalWeight === 0 ? 0 : passedWeight / totalWeight,
    falsePositiveRate:
      nullCases.length === 0 ? 0 : nullFalsePositives / nullCases.length,
    trajectoryCaptureRate:
      results.length === 0 ? 0 : trajectoryHits / results.length,
    latency: {
      avg: latencyAvg,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    bySuite,
    byVariant,
    byRiskClass,
    failures: results.filter((result) => !result.pass),
    results,
  };
}

export function buildAxOptimizationRows(
  report: PromptBenchmarkReport,
): AxOptimizationRow[] {
  return report.results.map((result) => ({
    id: result.case.caseId,
    suiteId: result.case.suiteId,
    baseScenarioId: result.case.baseScenarioId,
    variantId: result.case.variantId,
    prompt: result.case.prompt,
    axes: [...result.case.axes],
    expected: {
      action: result.case.expectedAction,
      acceptableActions: [...result.case.acceptableActions],
      forbiddenActions: [...result.case.forbiddenActions],
      operation: result.case.expectedOperation,
    },
    observed: {
      action: result.actualPrimaryAction,
      actions: [...result.actualActions],
      responseText: result.responseText,
      ...(result.plannerPrompt ? { plannerPrompt: result.plannerPrompt } : {}),
      ...(result.plannerResponse
        ? { plannerResponse: result.plannerResponse }
        : {}),
      ...(result.trajectoryId ? { trajectoryId: result.trajectoryId } : {}),
    },
    metrics: {
      pass: result.pass,
      latencyMs: result.latencyMs,
      llmCallCount: result.llmCallCount,
      benchmarkWeight: result.case.benchmarkWeight,
    },
  }));
}

export function serializeAxOptimizationRows(rows: AxOptimizationRow[]): string {
  return rows
    .map((row) => JSON.stringify(row))
    .join("\n")
    .concat("\n");
}

export function formatPromptBenchmarkReportMarkdown(
  report: PromptBenchmarkReport,
): string {
  const lines: string[] = [];
  lines.push("# LifeOps Prompt Benchmark");
  lines.push("");
  lines.push(
    `Provider: **${report.providerName}** · accuracy **${(report.accuracy * 100).toFixed(1)}%** (${report.passed}/${report.total}) · weighted **${(report.weightedAccuracy * 100).toFixed(1)}%**`,
  );
  lines.push(
    `Null-case false positive rate: **${(report.falsePositiveRate * 100).toFixed(1)}%** · trajectory capture **${(report.trajectoryCaptureRate * 100).toFixed(1)}%**`,
  );
  lines.push(
    `Latency: avg ${Math.round(report.latency.avg)}ms · p50 ${Math.round(report.latency.p50)}ms · p95 ${Math.round(report.latency.p95)}ms`,
  );
  lines.push("");
  lines.push("## By Suite");
  lines.push("");
  lines.push("| Suite | Passed | Total | Accuracy |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [suiteId, stats] of Object.entries(report.bySuite).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(
      `| ${suiteId} | ${stats.passed} | ${stats.total} | ${(stats.accuracy * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");
  lines.push("## By Variant");
  lines.push("");
  lines.push("| Variant | Passed | Total | Accuracy |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [variantId, stats] of Object.entries(report.byVariant).sort(
    (a, b) => a[0].localeCompare(b[0]),
  )) {
    lines.push(
      `| ${variantId} | ${stats.passed} | ${stats.total} | ${(stats.accuracy * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");
  if (report.failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of report.failures.slice(0, 20)) {
      lines.push(
        `- \`${failure.case.caseId}\` expected \`${failure.case.expectedAction ?? "null/REPLY"}\` but saw \`${failure.actualPrimaryAction ?? "null"}\``,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function createLifeOpsPromptBenchmarkRuntime(args?: {
  preferredProvider?: LiveProviderName;
}): Promise<RealTestRuntimeResult> {
  const provider = args?.preferredProvider
    ? selectLiveProvider(args.preferredProvider)
    : selectLiveProvider();
  if (!provider) {
    throw new Error("No live provider is configured for prompt benchmarking.");
  }

  const runtimeResult = await createLifeOpsTestRuntime({
    withLLM: true,
    preferredProvider: provider.name,
  });
  if (!runtimeResult.providerName) {
    await runtimeResult.cleanup();
    throw new Error(
      "Prompt benchmark runtime failed to register an LLM provider.",
    );
  }
  return runtimeResult;
}

export async function runLifeOpsPromptBenchmark(
  options: RunOptions,
): Promise<PromptBenchmarkReport> {
  const timeoutMs = options.timeoutMsPerCase ?? DEFAULT_TIMEOUT_MS;
  const isolate = options.isolate ?? "shared";
  const results: PromptBenchmarkResult[] = [];

  if (options.runtime) {
    for (const testCase of options.cases) {
      results.push(
        await runSinglePromptBenchmarkCase({
          runtime: options.runtime,
          testCase,
          timeoutMs,
        }),
      );
    }
    return buildPromptBenchmarkReport({
      providerName: "external-runtime",
      results,
    });
  }

  if (isolate === "shared") {
    const runtimeResult = await createLifeOpsPromptBenchmarkRuntime({
      preferredProvider: options.preferredProvider,
    });
    try {
      for (const testCase of options.cases) {
        results.push(
          await runSinglePromptBenchmarkCase({
            runtime: runtimeResult.runtime,
            testCase,
            timeoutMs,
          }),
        );
      }
      return buildPromptBenchmarkReport({
        providerName: runtimeResult.providerName ?? "unknown",
        results,
      });
    } finally {
      await runtimeResult.cleanup();
    }
  }

  for (const testCase of options.cases) {
    const runtimeResult = await createLifeOpsPromptBenchmarkRuntime({
      preferredProvider: options.preferredProvider,
    });
    try {
      results.push(
        await runSinglePromptBenchmarkCase({
          runtime: runtimeResult.runtime,
          testCase,
          timeoutMs,
        }),
      );
    } finally {
      await runtimeResult.cleanup();
    }
  }

  const providerName = results.length > 0 ? "isolated-runtime" : "unknown";
  return buildPromptBenchmarkReport({ providerName, results });
}
