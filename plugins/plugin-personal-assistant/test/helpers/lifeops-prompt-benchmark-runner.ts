/**
 * Runs the LifeOps prompt benchmark against a real runtime, driving conversations and
 * capturing model trajectories (LLM calls) for scoring.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentRuntime,
  ElizaError,
  type ReportedError,
} from "@elizaos/core";
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
import {
  probeMtpFork,
  resolveLocalBaseUrl,
} from "../../../../packages/benchmarks/lib/src/local-llama-cpp.ts";
import {
  type ModelTier,
  resolveTier,
} from "../../../../packages/benchmarks/lib/src/model-tiers.ts";
import { computeCallCostUsd } from "../../../../packages/core/src/features/trajectories/pricing.ts";
import {
  createJsonFileTrajectoryRecorder,
  isTrajectoryRecordingEnabled,
  type RecordedTrajectory,
} from "../../../../packages/core/src/runtime/trajectory-recorder.ts";
import { actionsAreScenarioEquivalent } from "../../../../packages/scenario-runner/src/action-families.ts";
import type {
  LifeOpsPromptBenchmarkTask,
  PromptBenchmarkCase,
  PromptBenchmarkRiskClass,
  PromptBenchmarkSuiteId,
  PromptBenchmarkVariantId,
} from "./lifeops-prompt-benchmark-cases.ts";
import { createLifeOpsTestRuntime } from "./runtime.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const PASSIVE_ACTIONS = new Set(["REPLY", "IGNORE", "NONE", "CHOOSE_OPTION"]);

export type PromptBenchmarkTerminalOutcome =
  | { status: "completed" }
  | {
      status: "capability_unavailable";
      capability: string;
      reason: string;
    }
  | {
      status: "failed";
      failureKind:
        | "exception"
        | "runtime_error"
        | "action_failed"
        | "structured_failure_reply"
        | "trajectory_error"
        | "incomplete";
      reason: string;
    };

export type PromptBenchmarkActionFailure = {
  actionName: string;
  actionStatus: string;
  error?: string;
};

export type PromptBenchmarkCapabilityProfile = {
  id: "host" | "mobile";
  filteredActionNames: readonly string[];
  unavailableExpectedActions: Readonly<Record<string, string>>;
  unavailableCases: Readonly<
    Record<string, { capability: string; reason: string }>
  >;
};

/**
 * The hosted lane has no owner calendar, Capacitor app-blocker, or native
 * screen-time source. Mixed app/website BLOCK virtuals are removed as a group
 * so an app target is never exposed accidentally; website lifecycle-only
 * virtuals stay available. Calendar-dependent cases are skipped before a turn
 * because connector failure after execution is not capability detection.
 */
export const HOST_PROMPT_BENCHMARK_CAPABILITIES: PromptBenchmarkCapabilityProfile =
  {
    id: "host",
    filteredActionNames: [
      "BLOCK",
      "BLOCK_BLOCK",
      "BLOCK_UNBLOCK",
      "BLOCK_STATUS",
    ],
    unavailableExpectedActions: {
      CALENDAR:
        "The hosted benchmark does not authenticate an owner calendar, so live calendar reads and writes are unavailable without risking external account mutation.",
      OWNER_SCREENTIME:
        "Native screen-time signals require the macOS activity tracker or a mobile device and are unavailable on the hosted Linux benchmark runtime.",
    },
    unavailableCases: {
      "lifeops-capability.meeting_prep__direct": {
        capability: "MEETING_DOSSIER",
        reason:
          "Meeting dossier generation requires a connected calendar with an upcoming event plus its document corpus; the hosted benchmark has neither owner data source.",
      },
    },
  };

export const MOBILE_PROMPT_BENCHMARK_CAPABILITIES: PromptBenchmarkCapabilityProfile =
  {
    id: "mobile",
    filteredActionNames: [],
    unavailableExpectedActions: {},
    unavailableCases: {},
  };

export function resolvePromptBenchmarkCapabilityProfile(
  target = process.env.LIFEOPS_PROMPT_BENCHMARK_TARGET,
): PromptBenchmarkCapabilityProfile {
  const normalized = target?.trim().toLowerCase();
  if (!normalized || normalized === "host") {
    return HOST_PROMPT_BENCHMARK_CAPABILITIES;
  }
  if (normalized === "mobile") {
    return MOBILE_PROMPT_BENCHMARK_CAPABILITIES;
  }
  throw new ElizaError(
    `Unsupported LifeOps prompt benchmark target: ${target}`,
    {
      code: "LIFEOPS_PROMPT_BENCHMARK_TARGET_INVALID",
      context: { target },
    },
  );
}

export type PromptBenchmarkResult = {
  case: PromptBenchmarkCase;
  terminalOutcome: PromptBenchmarkTerminalOutcome;
  actualPrimaryAction: string | null;
  actualActions: string[];
  actionFailures: PromptBenchmarkActionFailure[];
  runtimeErrors: ReportedError[];
  pass: boolean;
  latencyMs: number;
  responseText: string;
  error?: string;
  trajectoryId?: string;
  trajectoryStatus?: Trajectory["status"];
  nativeTrajectoryId?: string;
  nativeTrajectoryStatus?: RecordedTrajectory["status"];
  nativeTrajectoryRelativePath?: string;
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
  cacheHitPct?: number | null;
  // USD cost across every llmCall on this case, computed via
  // `computeCallCostUsd` against the canonical price table at
  // `packages/core/src/features/trajectories/pricing.ts`. Mirrors the Python
  // side's `TurnResult.cost_usd`. Cache-read tokens bill at the cache-read
  // rate, cache-creation tokens bill at the cache-write rate, the remainder
  // bills at the input rate — matching `computeCallCostUsd`'s formula.
  costUsd?: number;
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
  capabilityProfile: PromptBenchmarkCapabilityProfile["id"];
  total: number;
  scoredTotal: number;
  completed: number;
  unavailable: number;
  terminalFailed: number;
  passed: number;
  failed: number;
  accuracy: number;
  weightedAccuracy: number;
  falsePositiveRate: number;
  trajectoryCaptureRate: number;
  latency: PromptBenchmarkLatencyStats;
  bySuite: Record<PromptBenchmarkSuiteId, PromptBenchmarkSliceStats>;
  byTask: Record<LifeOpsPromptBenchmarkTask, PromptBenchmarkSliceStats>;
  byVariant: Record<PromptBenchmarkVariantId, PromptBenchmarkSliceStats>;
  byRiskClass: Record<PromptBenchmarkRiskClass, PromptBenchmarkSliceStats>;
  failures: PromptBenchmarkResult[];
  unavailableCases: PromptBenchmarkResult[];
  results: PromptBenchmarkResult[];
};

export type AxOptimizationRow = {
  id: string;
  suiteId: PromptBenchmarkSuiteId;
  baseScenarioId: string;
  optimizationTask: PromptBenchmarkCase["optimizationTask"];
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
    terminalOutcome: PromptBenchmarkTerminalOutcome;
    actionFailures: PromptBenchmarkActionFailure[];
    runtimeErrors: ReportedError[];
    nativeTrajectoryId?: string;
    nativeTrajectoryStatus?: RecordedTrajectory["status"];
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
      status?: Trajectory["status"];
    }>;
  }>;
  getTrajectoryDetail: (trajectoryId: string) => Promise<Trajectory | null>;
};

type RunOptions = {
  cases: PromptBenchmarkCase[];
  isolate?: "shared" | "per-case";
  preferredProvider?: LiveProviderName;
  modelTier?: ModelTier;
  runtime?: AgentRuntime;
  timeoutMsPerCase?: number;
  capabilityProfile?: PromptBenchmarkCapabilityProfile;
  requireNativeTrajectories?: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function promptBenchmarkActionIsAvailable(
  actionName: string,
  capabilityProfile: PromptBenchmarkCapabilityProfile,
): boolean {
  const normalized = normalizeActionName(actionName);
  return !capabilityProfile.filteredActionNames.some(
    (filtered) => normalizeActionName(filtered) === normalized,
  );
}

function applyPromptBenchmarkCapabilityProfile(
  runtime: AgentRuntime,
  capabilityProfile: PromptBenchmarkCapabilityProfile,
): void {
  for (const actionName of capabilityProfile.filteredActionNames) {
    runtime.unregisterAction(actionName);
  }
}

export function promptBenchmarkCapabilityUnavailableForCase(args: {
  capabilityProfile: PromptBenchmarkCapabilityProfile;
  testCase: PromptBenchmarkCase;
}): PromptBenchmarkTerminalOutcome | null {
  const unavailableCase =
    args.capabilityProfile.unavailableCases[args.testCase.caseId];
  if (unavailableCase) {
    return {
      status: "capability_unavailable",
      capability: unavailableCase.capability,
      reason: unavailableCase.reason,
    };
  }
  const expected = normalizeActionName(args.testCase.expectedAction);
  if (!expected) {
    return null;
  }
  const reason = args.capabilityProfile.unavailableExpectedActions[expected];
  if (!reason) {
    return null;
  }
  return {
    status: "capability_unavailable",
    capability: expected,
    reason,
  };
}

function reportedErrorsSince(
  runtime: AgentRuntime,
  startedAt: number,
): ReportedError[] {
  return runtime
    .getRecentReportedErrors()
    .filter((entry) => entry.at >= startedAt)
    .map((entry) => ({ ...entry }));
}

function actionResultError(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const candidate of [value.error, value.reason, value.message]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  for (const nested of [value.data, value.values]) {
    const error = actionResultError(nested);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function actionResultRequiresConfirmation(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.requiresConfirmation === true) {
    return true;
  }
  return [value.data, value.values].some((nested) =>
    actionResultRequiresConfirmation(nested),
  );
}

function isDesignedConfirmationError(error: string): boolean {
  const normalized = error.trim().toUpperCase();
  return (
    normalized.startsWith("MISSING_") ||
    normalized.startsWith("AMBIGUOUS_") ||
    normalized.endsWith("_NOT_RESOLVED")
  );
}

function collectActionFailures(
  actions: Awaited<ReturnType<ConversationHarness["send"]>>["actions"],
): PromptBenchmarkActionFailure[] {
  return actions
    .filter(
      (action) =>
        action.phase === "completed" &&
        action.actionStatus === "failed" &&
        action.actionConfirmationPending !== true,
    )
    .map((action) => {
      const content = action.payload.content;
      const error = actionResultError(
        isRecord(content) ? content.actionResult : undefined,
      );
      return {
        actionName: action.actionName,
        actionStatus: action.actionStatus ?? "failed",
        ...(error ? { error } : {}),
      };
    });
}

/**
 * Native trajectories are the durable source of truth for tool results. A
 * structured error must still fail the case when an action also requests
 * confirmation; only missing, ambiguous, or unresolved user input is a
 * designed terminal clarification.
 */
export function collectNativeTrajectoryActionFailures(
  trajectory: Pick<RecordedTrajectory, "stages"> | null,
): PromptBenchmarkActionFailure[] {
  if (!trajectory) {
    return [];
  }
  return trajectory.stages.flatMap((stage) => {
    const tool = stage.kind === "tool" ? stage.tool : undefined;
    if (!tool || tool.success) {
      return [];
    }
    const error =
      actionResultError(tool.result) ?? tool.errorText ?? tool.error;
    if (
      actionResultRequiresConfirmation(tool.result) &&
      (!error || isDesignedConfirmationError(error))
    ) {
      return [];
    }
    return [
      {
        actionName: tool.name,
        actionStatus: "failed",
        ...(error ? { error } : {}),
      },
    ];
  });
}

function mergeActionFailures(
  ...failureGroups: readonly (readonly PromptBenchmarkActionFailure[])[]
): PromptBenchmarkActionFailure[] {
  const failures = new Map<string, PromptBenchmarkActionFailure>();
  for (const failure of failureGroups.flat()) {
    const key = `${failure.actionName}\u0000${failure.actionStatus}\u0000${failure.error ?? ""}`;
    failures.set(key, failure);
  }
  return [...failures.values()];
}

function collectStructuredFailureKinds(
  responses: Awaited<ReturnType<ConversationHarness["send"]>>["responses"],
): string[] {
  return uniqueStrings(
    responses.map((response) => {
      const content = response.content;
      if (!isRecord(content)) {
        return undefined;
      }
      return typeof content.failureKind === "string"
        ? content.failureKind
        : undefined;
    }),
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
  trajectoryStatus?: Trajectory["status"];
  plannerPrompt?: string;
  plannerResponse?: string;
  llmCallCount: number;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalInputTokens?: number;
  cacheHitPct?: number | null;
  costUsd?: number;
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
  // costUsd is computed per-call against the canonical price table so the
  // TS report matches the Python TurnResult.cost_usd values for the same
  // model / token / cache breakdown.
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let costUsd = 0;
  for (const c of llmCalls) {
    const cAny = c as Record<string, unknown>;
    const callPromptTokens =
      Number(cAny.promptTokens ?? cAny.inputTokens ?? 0) || 0;
    const callCompletionTokens =
      Number(cAny.completionTokens ?? cAny.outputTokens ?? 0) || 0;
    const callCacheRead =
      Number(cAny.cacheReadInputTokens ?? cAny.cachedInputTokens ?? 0) || 0;
    const callCacheCreate = Number(cAny.cacheCreationInputTokens ?? 0) || 0;
    promptTokens += callPromptTokens;
    completionTokens += callCompletionTokens;
    cacheRead += callCacheRead;
    cacheCreate += callCacheCreate;
    const modelName =
      typeof cAny.modelName === "string"
        ? cAny.modelName
        : typeof cAny.model === "string"
          ? cAny.model
          : undefined;
    const provider =
      typeof cAny.provider === "string" ? cAny.provider : undefined;
    costUsd += computeCallCostUsd(
      modelName,
      {
        promptTokens: callPromptTokens,
        completionTokens: callCompletionTokens,
        cacheReadInputTokens: callCacheRead,
        cacheCreationInputTokens: callCacheCreate,
      },
      { provider },
    );
  }
  const totalInput = promptTokens + cacheRead + cacheCreate;
  const cacheHitPct =
    totalInput > 0 ? +((cacheRead / totalInput) * 100).toFixed(2) : null;

  return {
    trajectoryId: bestDetail?.trajectoryId,
    trajectoryStatus: bestDetail?.status,
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
    costUsd,
  };
}

async function captureNativeTrajectoryForCase(args: {
  prompt: string;
  scenarioId: string;
  startedAtMs: number;
}): Promise<RecordedTrajectory | null> {
  if (!isTrajectoryRecordingEnabled()) {
    return null;
  }
  const recorder = createJsonFileTrajectoryRecorder({ enabled: true });
  let newestMatch: RecordedTrajectory | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const trajectories = await recorder.list({
      since: args.startedAtMs - 2_000,
      limit: 32,
    });
    newestMatch =
      trajectories.find(
        (trajectory) =>
          trajectory.scenarioId === args.scenarioId &&
          normalizeComparableText(trajectory.rootMessage.text) ===
            normalizeComparableText(args.prompt),
      ) ?? null;
    if (newestMatch && newestMatch.status !== "running") {
      return newestMatch;
    }
    await sleep(50);
  }
  return newestMatch;
}

export function resolvePromptBenchmarkTerminalOutcome(args: {
  actionFailures: readonly PromptBenchmarkActionFailure[];
  runtimeErrors: readonly ReportedError[];
  structuredFailureKinds?: readonly string[];
  trajectoryStatus?: Trajectory["status"];
  nativeTrajectory?: Pick<RecordedTrajectory, "status"> | null;
  requireNativeTrajectory: boolean;
  thrownError?: string;
}): PromptBenchmarkTerminalOutcome {
  if (args.thrownError) {
    return {
      status: "failed",
      failureKind: "exception",
      reason: args.thrownError,
    };
  }
  if (args.runtimeErrors.length > 0) {
    const first = args.runtimeErrors[0];
    return {
      status: "failed",
      failureKind: "runtime_error",
      reason: first
        ? `${first.scope}:${first.code}: ${first.message}`
        : "The runtime reported an unclassified error during the case.",
    };
  }
  if (args.actionFailures.length > 0) {
    const first = args.actionFailures[0];
    return {
      status: "failed",
      failureKind: "action_failed",
      reason: first
        ? `${first.actionName}: ${first.error ?? first.actionStatus}`
        : "An action failed during the case.",
    };
  }
  if (args.structuredFailureKinds?.length) {
    return {
      status: "failed",
      failureKind: "structured_failure_reply",
      reason: `The runtime returned a structured failure reply (${args.structuredFailureKinds.join(", ")}).`,
    };
  }
  if (
    args.trajectoryStatus === "error" ||
    args.trajectoryStatus === "timeout" ||
    args.nativeTrajectory?.status === "errored"
  ) {
    return {
      status: "failed",
      failureKind: "trajectory_error",
      reason: `Trajectory ended unsuccessfully (database=${args.trajectoryStatus ?? "missing"}, native=${args.nativeTrajectory?.status ?? "missing"}).`,
    };
  }
  if (
    args.trajectoryStatus === "active" ||
    args.nativeTrajectory?.status === "running"
  ) {
    return {
      status: "failed",
      failureKind: "incomplete",
      reason: `Trajectory did not reach a terminal status (database=${args.trajectoryStatus ?? "missing"}, native=${args.nativeTrajectory?.status ?? "missing"}).`,
    };
  }
  if (args.requireNativeTrajectory && !args.nativeTrajectory) {
    return {
      status: "failed",
      failureKind: "incomplete",
      reason: "Required native trajectory was not captured for the case.",
    };
  }
  return { status: "completed" };
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
  if (result.terminalOutcome.status !== "completed") {
    return false;
  }
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
  capabilityProfile: PromptBenchmarkCapabilityProfile;
  requireNativeTrajectory: boolean;
  runtime: AgentRuntime;
  testCase: PromptBenchmarkCase;
  timeoutMs: number;
}): Promise<PromptBenchmarkResult> {
  const unavailable = promptBenchmarkCapabilityUnavailableForCase({
    capabilityProfile: args.capabilityProfile,
    testCase: args.testCase,
  });
  if (unavailable) {
    return {
      case: args.testCase,
      terminalOutcome: unavailable,
      actualPrimaryAction: null,
      actualActions: [],
      actionFailures: [],
      runtimeErrors: [],
      latencyMs: 0,
      llmCallCount: 0,
      pass: false,
      responseText: "",
    };
  }

  const harness = new ConversationHarness(args.runtime, {
    userName: "Owner",
    source: "dashboard",
  });

  // Tag every trajectory landed during this case so the aggregator can
  // group per-case JSONL bundles.
  const previousScenarioId = process.env.ELIZA_LIFEOPS_SCENARIO_ID;
  process.env.ELIZA_LIFEOPS_SCENARIO_ID = args.testCase.caseId;
  const caseStartedAt = Date.now();

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
    const nativeTrajectory = await captureNativeTrajectoryForCase({
      prompt: args.testCase.prompt,
      scenarioId: args.testCase.caseId,
      startedAtMs: turn.startedAt,
    });
    const actionFailures = mergeActionFailures(
      collectActionFailures(turn.actions),
      collectNativeTrajectoryActionFailures(nativeTrajectory),
    );
    const runtimeErrors = reportedErrorsSince(args.runtime, caseStartedAt);
    const terminalOutcome = resolvePromptBenchmarkTerminalOutcome({
      actionFailures,
      runtimeErrors,
      structuredFailureKinds: collectStructuredFailureKinds(turn.responses),
      trajectoryStatus: trajectory.trajectoryStatus,
      nativeTrajectory,
      requireNativeTrajectory: args.requireNativeTrajectory,
    });

    const provisional = {
      case: args.testCase,
      terminalOutcome,
      actualPrimaryAction: selectPrimaryAction(actualActions),
      actualActions,
      actionFailures,
      runtimeErrors,
      latencyMs: turn.durationMs,
      llmCallCount: trajectory.llmCallCount,
      pass: false,
      plannerPrompt: trajectory.plannerPrompt,
      plannerResponse: trajectory.plannerResponse,
      responseText: turn.responseText,
      trajectoryId: trajectory.trajectoryId,
      trajectoryStatus: trajectory.trajectoryStatus,
      nativeTrajectoryId: nativeTrajectory?.trajectoryId,
      nativeTrajectoryStatus: nativeTrajectory?.status,
      nativeTrajectoryRelativePath: nativeTrajectory
        ? `${nativeTrajectory.agentId}/${nativeTrajectory.trajectoryId}.json`
        : undefined,
      promptTokens: trajectory.promptTokens,
      completionTokens: trajectory.completionTokens,
      cacheReadInputTokens: trajectory.cacheReadInputTokens,
      cacheCreationInputTokens: trajectory.cacheCreationInputTokens,
      totalInputTokens: trajectory.totalInputTokens,
      cacheHitPct: trajectory.cacheHitPct,
      costUsd: trajectory.costUsd,
      ...(terminalOutcome.status === "failed"
        ? { error: terminalOutcome.reason }
        : {}),
    } satisfies Omit<PromptBenchmarkResult, "pass"> & { pass: boolean };

    return {
      ...provisional,
      pass: promptBenchmarkCasePasses(provisional),
    };
  } catch (error) {
    // error-policy:J1 benchmark case boundary translates an exception into a
    // typed failed row so the remaining cases and review artifacts still land.
    const message = error instanceof Error ? error.message : String(error);
    const nativeTrajectory = await captureNativeTrajectoryForCase({
      prompt: args.testCase.prompt,
      scenarioId: args.testCase.caseId,
      startedAtMs: caseStartedAt,
    });
    const runtimeErrors = reportedErrorsSince(args.runtime, caseStartedAt);
    const terminalOutcome = resolvePromptBenchmarkTerminalOutcome({
      actionFailures: [],
      runtimeErrors,
      nativeTrajectory,
      requireNativeTrajectory: args.requireNativeTrajectory,
      thrownError: message,
    });
    const failed = {
      case: args.testCase,
      terminalOutcome,
      actualPrimaryAction: null,
      actualActions: [],
      actionFailures: [],
      runtimeErrors,
      error: message,
      latencyMs: 0,
      llmCallCount: 0,
      nativeTrajectoryId: nativeTrajectory?.trajectoryId,
      nativeTrajectoryStatus: nativeTrajectory?.status,
      nativeTrajectoryRelativePath: nativeTrajectory
        ? `${nativeTrajectory.agentId}/${nativeTrajectory.trajectoryId}.json`
        : undefined,
      pass: false,
      responseText: "",
    } satisfies PromptBenchmarkResult;
    return failed;
  } finally {
    await harness.cleanup();
    if (previousScenarioId === undefined) {
      delete process.env.ELIZA_LIFEOPS_SCENARIO_ID;
    } else {
      process.env.ELIZA_LIFEOPS_SCENARIO_ID = previousScenarioId;
    }
  }
}

export function buildPromptBenchmarkReport(args: {
  capabilityProfile: PromptBenchmarkCapabilityProfile["id"];
  providerName: string;
  results: PromptBenchmarkResult[];
}): PromptBenchmarkReport {
  const { capabilityProfile, providerName, results } = args;
  const scoredResults = results.filter(
    (result) => result.terminalOutcome.status !== "capability_unavailable",
  );
  const passed = results.filter((result) => result.pass).length;
  const failed = scoredResults.length - passed;
  const completed = results.filter(
    (result) => result.terminalOutcome.status === "completed",
  ).length;
  const unavailable = results.filter(
    (result) => result.terminalOutcome.status === "capability_unavailable",
  ).length;
  const terminalFailed = results.filter(
    (result) => result.terminalOutcome.status === "failed",
  ).length;
  const totalWeight = scoredResults.reduce(
    (sum, result) => sum + result.case.benchmarkWeight,
    0,
  );
  const passedWeight = scoredResults
    .filter((result) => result.pass)
    .reduce((sum, result) => sum + result.case.benchmarkWeight, 0);
  const nullCases = scoredResults.filter(
    (result) => result.case.riskClass === "null",
  );
  const nullFalsePositives = nullCases.filter((result) => !result.pass).length;
  const trajectoryHits = scoredResults.filter(
    (result) => typeof result.trajectoryId === "string" && result.trajectoryId,
  ).length;

  const bySuite = {} as Record<
    PromptBenchmarkSuiteId,
    PromptBenchmarkSliceStats
  >;
  const byTask = {} as Record<
    LifeOpsPromptBenchmarkTask,
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

  for (const result of scoredResults) {
    const buckets: Array<[Record<string, PromptBenchmarkSliceStats>, string]> =
      [
        [
          bySuite as Record<string, PromptBenchmarkSliceStats>,
          result.case.suiteId,
        ],
        [
          byTask as Record<string, PromptBenchmarkSliceStats>,
          result.case.optimizationTask,
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

  for (const collection of [bySuite, byTask, byVariant, byRiskClass]) {
    for (const key of Object.keys(collection)) {
      const bucket = collection[key as keyof typeof collection];
      if (!bucket) {
        continue;
      }
      bucket.accuracy = bucket.total === 0 ? 0 : bucket.passed / bucket.total;
    }
  }

  const latencies = [...scoredResults.map((result) => result.latencyMs)].sort(
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
    capabilityProfile,
    total: results.length,
    scoredTotal: scoredResults.length,
    completed,
    unavailable,
    terminalFailed,
    passed,
    failed,
    accuracy: scoredResults.length === 0 ? 0 : passed / scoredResults.length,
    weightedAccuracy: totalWeight === 0 ? 0 : passedWeight / totalWeight,
    falsePositiveRate:
      nullCases.length === 0 ? 0 : nullFalsePositives / nullCases.length,
    trajectoryCaptureRate:
      scoredResults.length === 0 ? 0 : trajectoryHits / scoredResults.length,
    latency: {
      avg: latencyAvg,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    bySuite,
    byTask,
    byVariant,
    byRiskClass,
    failures: results.filter(
      (result) =>
        result.terminalOutcome.status !== "capability_unavailable" &&
        !result.pass,
    ),
    unavailableCases: results.filter(
      (result) => result.terminalOutcome.status === "capability_unavailable",
    ),
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
    optimizationTask: result.case.optimizationTask,
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
      terminalOutcome: result.terminalOutcome,
      actionFailures: result.actionFailures.map((failure) => ({ ...failure })),
      runtimeErrors: result.runtimeErrors.map((error) => ({ ...error })),
      responseText: result.responseText,
      ...(result.plannerPrompt ? { plannerPrompt: result.plannerPrompt } : {}),
      ...(result.plannerResponse
        ? { plannerResponse: result.plannerResponse }
        : {}),
      ...(result.trajectoryId ? { trajectoryId: result.trajectoryId } : {}),
      ...(result.nativeTrajectoryId
        ? { nativeTrajectoryId: result.nativeTrajectoryId }
        : {}),
      ...(result.nativeTrajectoryStatus
        ? { nativeTrajectoryStatus: result.nativeTrajectoryStatus }
        : {}),
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
    `Provider: **${report.providerName}** · accuracy **${(report.accuracy * 100).toFixed(1)}%** (${report.passed}/${report.scoredTotal} scored; ${report.total} selected) · weighted **${(report.weightedAccuracy * 100).toFixed(1)}%**`,
  );
  lines.push(
    `Capability profile: **${report.capabilityProfile}** · terminal completed **${report.completed}** · unavailable **${report.unavailable}** · failed **${report.terminalFailed}**`,
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
  lines.push("## By Task");
  lines.push("");
  lines.push("| Task | Passed | Total | Accuracy |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [task, stats] of Object.entries(report.byTask).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(
      `| ${task} | ${stats.passed} | ${stats.total} | ${(stats.accuracy * 100).toFixed(1)}% |`,
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
  if (report.unavailableCases.length > 0) {
    lines.push("## Capability Unavailable");
    lines.push("");
    for (const result of report.unavailableCases) {
      const outcome = result.terminalOutcome;
      if (outcome.status !== "capability_unavailable") {
        continue;
      }
      lines.push(
        `- \`${result.case.caseId}\` (${outcome.capability}): ${outcome.reason}`,
      );
    }
    lines.push("");
  }
  if (report.failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of report.failures.slice(0, 20)) {
      const terminalDetail =
        failure.terminalOutcome.status === "failed"
          ? `; terminal ${failure.terminalOutcome.failureKind}: ${failure.terminalOutcome.reason}`
          : "";
      lines.push(
        `- \`${failure.case.caseId}\` expected \`${failure.case.expectedAction ?? "null/REPLY"}\` but saw \`${failure.actualPrimaryAction ?? "null"}\`${terminalDetail}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function promptBenchmarkValidationErrors(args: {
  minimumAccuracy: number;
  report: PromptBenchmarkReport;
}): string[] {
  const errors: string[] = [];
  if (
    !Number.isFinite(args.minimumAccuracy) ||
    args.minimumAccuracy < 0 ||
    args.minimumAccuracy > 1
  ) {
    errors.push(
      `Minimum accuracy must be a finite fraction from 0 through 1; received ${String(args.minimumAccuracy)}.`,
    );
  }
  if (args.report.total === 0) {
    errors.push("No benchmark cases were selected.");
  }
  for (const result of args.report.results) {
    if (result.terminalOutcome.status === "failed") {
      errors.push(
        `${result.case.caseId}: ${result.terminalOutcome.failureKind}: ${result.terminalOutcome.reason}`,
      );
      continue;
    }
    if (result.terminalOutcome.status === "capability_unavailable") {
      if (!result.terminalOutcome.reason.trim()) {
        errors.push(
          `${result.case.caseId}: capability-unavailable outcome has no reason.`,
        );
      }
      if (result.runtimeErrors.length > 0 || result.actionFailures.length > 0) {
        errors.push(
          `${result.case.caseId}: capability-unavailable case executed and produced failures.`,
        );
      }
      continue;
    }
    if (result.runtimeErrors.length > 0) {
      errors.push(
        `${result.case.caseId}: completed outcome contains ${result.runtimeErrors.length} hidden runtime error(s).`,
      );
    }
    if (result.actionFailures.length > 0) {
      errors.push(
        `${result.case.caseId}: completed outcome contains ${result.actionFailures.length} failed action(s).`,
      );
    }
    if (
      result.trajectoryStatus === "error" ||
      result.trajectoryStatus === "timeout" ||
      result.trajectoryStatus === "active" ||
      result.nativeTrajectoryStatus === "errored" ||
      result.nativeTrajectoryStatus === "running"
    ) {
      errors.push(
        `${result.case.caseId}: completed outcome contains a non-success trajectory status.`,
      );
    }
  }
  if (
    Number.isFinite(args.minimumAccuracy) &&
    args.report.accuracy < args.minimumAccuracy
  ) {
    errors.push(
      `Accuracy ${(args.report.accuracy * 100).toFixed(1)}% is below the required ${(args.minimumAccuracy * 100).toFixed(1)}%.`,
    );
  }
  return errors;
}

export function assertPromptBenchmarkReportValid(args: {
  minimumAccuracy: number;
  report: PromptBenchmarkReport;
}): void {
  const errors = promptBenchmarkValidationErrors(args);
  if (errors.length === 0) {
    return;
  }
  throw new ElizaError("LifeOps prompt benchmark failed closed validation.", {
    code: "LIFEOPS_PROMPT_BENCHMARK_INVALID",
    context: { errors },
  });
}

export async function createLifeOpsPromptBenchmarkRuntime(args?: {
  preferredProvider?: LiveProviderName;
  modelTier?: ModelTier;
}): Promise<RealTestRuntimeResult> {
  // If a MODEL_TIER is explicitly requested, set the canonical model env
  // vars (`ELIZA_LIVE_TEST_SMALL_MODEL`, `LARGE_MODEL`) so the live-provider
  // selector picks up the tier's model. Provider preference still wins —
  // tiers map to provider families (frontier→anthropic, large→cerebras, etc.)
  // but the operator's explicit preferredProvider override is honored.
  const tier = args?.modelTier
    ? resolveTier({ ...process.env, MODEL_TIER: args.modelTier })
    : resolveTier();
  if (args?.modelTier) {
    process.env.ELIZA_LIVE_TEST_SMALL_MODEL = tier.modelName;
    process.env.ELIZA_LIVE_TEST_LARGE_MODEL = tier.modelName;
    process.env.SMALL_MODEL = tier.modelName;
    process.env.LARGE_MODEL = tier.modelName;
    process.env.MODEL_TIER = tier.tier;
  }

  // Tier → provider preference. Operator's preferredProvider always wins.
  let tierProviderPreference: LiveProviderName | undefined;
  if (tier.provider === "anthropic") tierProviderPreference = "anthropic";
  else if (tier.provider === "cerebras") tierProviderPreference = "cerebras";
  else if (tier.provider === "openai") tierProviderPreference = "openai";
  else if (tier.provider === "local-llama-cpp" || tier.provider === "ollama") {
    tierProviderPreference = "local-llama-cpp";
    // Configure the OpenAI plugin to point at the local server. Prefer the
    // mtp fork (when built); otherwise fall back to Ollama via
    // ELIZA_OPENCODE_BASE_URL.
    const mtpBinary = probeMtpFork();
    if (!mtpBinary) {
      const fallback = resolveLocalBaseUrl();
      if (
        fallback.source === "ollama-default" &&
        !process.env.ELIZA_OPENCODE_BASE_URL
      ) {
        throw new Error(
          "MODEL_TIER=small|mid requires the mtp llama-cpp fork at " +
            "~/.cache/eliza-mtp/eliza-llama-cpp or ELIZA_OPENCODE_BASE_URL " +
            "pointing at a local OpenAI-compatible endpoint. Neither was found.",
        );
      }
      process.env.OPENAI_BASE_URL = fallback.baseUrl;
    }
    // Sentinel key — local servers don't authenticate, but selectLiveProvider
    // requires a non-empty key to consider a provider.
    if (!process.env.LOCAL_LLAMA_CPP_API_KEY) {
      process.env.LOCAL_LLAMA_CPP_API_KEY = "local";
    }
  }

  const preferred = args?.preferredProvider ?? tierProviderPreference;
  const provider = preferred
    ? selectLiveProvider(preferred)
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
  const capabilityProfile =
    options.capabilityProfile ?? resolvePromptBenchmarkCapabilityProfile();
  const requireNativeTrajectory = options.requireNativeTrajectories ?? false;
  const results: PromptBenchmarkResult[] = [];

  if (options.runtime) {
    applyPromptBenchmarkCapabilityProfile(options.runtime, capabilityProfile);
    for (const testCase of options.cases) {
      results.push(
        await runSinglePromptBenchmarkCase({
          capabilityProfile,
          requireNativeTrajectory,
          runtime: options.runtime,
          testCase,
          timeoutMs,
        }),
      );
    }
    return buildPromptBenchmarkReport({
      capabilityProfile: capabilityProfile.id,
      providerName: "external-runtime",
      results,
    });
  }

  if (isolate === "shared") {
    const runtimeResult = await createLifeOpsPromptBenchmarkRuntime({
      preferredProvider: options.preferredProvider,
      modelTier: options.modelTier,
    });
    try {
      applyPromptBenchmarkCapabilityProfile(
        runtimeResult.runtime,
        capabilityProfile,
      );
      for (const testCase of options.cases) {
        results.push(
          await runSinglePromptBenchmarkCase({
            capabilityProfile,
            requireNativeTrajectory,
            runtime: runtimeResult.runtime,
            testCase,
            timeoutMs,
          }),
        );
      }
      return buildPromptBenchmarkReport({
        capabilityProfile: capabilityProfile.id,
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
      modelTier: options.modelTier,
    });
    try {
      applyPromptBenchmarkCapabilityProfile(
        runtimeResult.runtime,
        capabilityProfile,
      );
      results.push(
        await runSinglePromptBenchmarkCase({
          capabilityProfile,
          requireNativeTrajectory,
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
  return buildPromptBenchmarkReport({
    capabilityProfile: capabilityProfile.id,
    providerName,
    results,
  });
}
