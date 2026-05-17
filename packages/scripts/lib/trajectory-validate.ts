import { computeCallCostUsd } from "./cost-table";

export type RecordedStageKind =
  | "messageHandler"
  | "planner"
  | "tool"
  | "evaluation"
  | "subPlanner"
  | "compaction";

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ToolDefinition {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ToolCallRecord {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens: number;
}

export interface ModelCallRecord {
  modelType: string;
  modelName?: string;
  provider: string;
  prompt: string;
  messages?: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: unknown;
  response: string;
  toolCalls?: ToolCallRecord[];
  usage?: UsageBreakdown;
  finishReason?: string;
  costUsd?: number;
}

export interface ToolStageRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
}

export interface EvaluationRecord {
  success: boolean;
  decision: string;
  thought?: string;
  messageToUser?: string;
  copyToClipboard?: unknown;
  recommendedToolCallId?: string;
  [key: string]: unknown;
}

export interface CacheStageRecord {
  segmentHashes: string[];
  prefixHash: string;
  diffFromPriorStage?: { added: number; unchanged: number; removed: number };
}

export interface RecordedStage {
  stageId: string;
  kind: RecordedStageKind;
  iteration?: number;
  parentStageId?: string;
  startedAt: number;
  endedAt: number;
  latencyMs: number;
  model?: ModelCallRecord;
  tool?: ToolStageRecord;
  evaluation?: EvaluationRecord;
  cache?: CacheStageRecord;
}

export interface RecordedTrajectoryMetrics {
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  plannerIterations: number;
  toolCallsExecuted: number;
  toolCallFailures: number;
  evaluatorFailures: number;
  finalDecision?: "FINISH" | "CONTINUE" | "max_iterations" | "error";
}

export interface RecordedTrajectory {
  trajectoryId: string;
  agentId: string;
  roomId?: string;
  rootMessage: { id: string; text: string; sender?: string };
  startedAt: number;
  endedAt?: number;
  status: "running" | "finished" | "errored";
  stages: RecordedStage[];
  metrics: RecordedTrajectoryMetrics;
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  path: string;
  message: string;
}

export interface TrajectoryRollup {
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  plannerIterations: number;
  toolCallsExecuted: number;
  toolCallFailures: number;
  evaluatorStages: number;
  evaluatorSuccesses: number;
  evaluatorFailures: number;
  modelCallStages: number;
  toolResultSuccesses: number;
  toolResultFailures: number;
}

export interface TrajectoryValidationResult {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
  rollup: TrajectoryRollup;
  selectedContexts: string[];
  stageKinds: string[];
}

export interface ValidateTrajectoryOptions {
  expectedStages?: string[];
  expectedContexts?: string[];
  costToleranceUsd?: number;
  requireMessageArrays?: boolean;
  requireContextEvidence?: boolean;
}

export interface CompareTrajectorySummary {
  idA: string;
  idB: string;
  a: TrajectoryRollup;
  b: TrajectoryRollup;
  delta: TrajectoryRollup;
  cacheHitRateA: number;
  cacheHitRateB: number;
  cacheHitRateDelta: number;
  estimatedBatchingDelta: {
    modelCalls: number;
    plannerIterations: number;
    stages: number;
    toolCalls: number;
  };
}

const STAGE_KINDS = new Set<RecordedStageKind>([
  "messageHandler",
  "planner",
  "tool",
  "evaluation",
  "subPlanner",
  "compaction",
]);

const MODEL_STAGE_KINDS = new Set<RecordedStageKind>([
  "messageHandler",
  "planner",
  "evaluation",
  "subPlanner",
  "compaction",
]);

const DEFAULT_ROLLUP: TrajectoryRollup = {
  totalLatencyMs: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalCostUsd: 0,
  plannerIterations: 0,
  toolCallsExecuted: 0,
  toolCallFailures: 0,
  evaluatorStages: 0,
  evaluatorSuccesses: 0,
  evaluatorFailures: 0,
  modelCallStages: 0,
  toolResultSuccesses: 0,
  toolResultFailures: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRollup(): TrajectoryRollup {
  return { ...DEFAULT_ROLLUP };
}

function pushIssue(
  issues: ValidationIssue[],
  severity: ValidationSeverity,
  path: string,
  message: string,
): void {
  issues.push({ severity, path, message });
}

function requireString(
  value: unknown,
  issues: ValidationIssue[],
  path: string,
  opts: { nonEmpty?: boolean } = {},
): value is string {
  if (typeof value !== "string") {
    pushIssue(issues, "error", path, "must be a string");
    return false;
  }
  if (opts.nonEmpty && value.trim().length === 0) {
    pushIssue(issues, "error", path, "must be a non-empty string");
    return false;
  }
  return true;
}

function requireNumber(
  value: unknown,
  issues: ValidationIssue[],
  path: string,
  opts: { integer?: boolean; min?: number } = {},
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushIssue(issues, "error", path, "must be a finite number");
    return false;
  }
  if (opts.integer && !Number.isInteger(value)) {
    pushIssue(issues, "error", path, "must be an integer");
    return false;
  }
  if (opts.min !== undefined && value < opts.min) {
    pushIssue(issues, "error", path, `must be >= ${opts.min}`);
    return false;
  }
  return true;
}

function parseJsonObject(
  text: string | undefined,
): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function numberDelta(a: number, b: number): number {
  return b - a;
}

function nearEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function metricNumber(
  metrics: Record<string, unknown> | undefined,
  key: keyof RecordedTrajectoryMetrics,
  issues: ValidationIssue[],
): number {
  const value = metrics?.[key];
  requireNumber(value, issues, `$.metrics.${key}`, { min: 0 });
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stagePath(index: number, suffix = ""): string {
  return `$.stages[${index}]${suffix}`;
}

function validateUsage(
  usage: unknown,
  issues: ValidationIssue[],
  path: string,
): UsageBreakdown | undefined {
  if (usage === undefined) return undefined;
  if (!isRecord(usage)) {
    pushIssue(issues, "error", path, "must be an object");
    return undefined;
  }
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  const totalTokens = usage.totalTokens;
  requireNumber(promptTokens, issues, `${path}.promptTokens`, {
    integer: true,
    min: 0,
  });
  requireNumber(completionTokens, issues, `${path}.completionTokens`, {
    integer: true,
    min: 0,
  });
  requireNumber(totalTokens, issues, `${path}.totalTokens`, {
    integer: true,
    min: 0,
  });

  const cacheRead = usage.cacheReadInputTokens;
  const cacheCreate = usage.cacheCreationInputTokens;
  if (cacheRead !== undefined) {
    requireNumber(cacheRead, issues, `${path}.cacheReadInputTokens`, {
      integer: true,
      min: 0,
    });
  }
  if (cacheCreate !== undefined) {
    requireNumber(cacheCreate, issues, `${path}.cacheCreationInputTokens`, {
      integer: true,
      min: 0,
    });
  }

  if (
    typeof promptTokens === "number" &&
    typeof completionTokens === "number" &&
    typeof totalTokens === "number" &&
    totalTokens !== promptTokens + completionTokens
  ) {
    pushIssue(
      issues,
      "error",
      `${path}.totalTokens`,
      "must equal promptTokens + completionTokens",
    );
  }
  if (
    typeof promptTokens === "number" &&
    typeof cacheRead === "number" &&
    cacheRead > promptTokens
  ) {
    pushIssue(
      issues,
      "error",
      `${path}.cacheReadInputTokens`,
      "must be <= promptTokens",
    );
  }
  if (
    typeof promptTokens === "number" &&
    typeof cacheCreate === "number" &&
    cacheCreate > promptTokens
  ) {
    pushIssue(
      issues,
      "error",
      `${path}.cacheCreationInputTokens`,
      "must be <= promptTokens",
    );
  }
  if (
    typeof promptTokens === "number" &&
    typeof cacheRead === "number" &&
    typeof cacheCreate === "number" &&
    cacheRead + cacheCreate > promptTokens
  ) {
    pushIssue(
      issues,
      "error",
      path,
      "cacheReadInputTokens + cacheCreationInputTokens must be <= promptTokens",
    );
  }

  return usage as unknown as UsageBreakdown;
}

function validateModel(
  model: unknown,
  stage: RecordedStage,
  index: number,
  issues: ValidationIssue[],
  opts: ValidateTrajectoryOptions,
): ModelCallRecord | undefined {
  const path = stagePath(index, ".model");
  if (!isRecord(model)) {
    pushIssue(issues, "error", path, "is required for model stages");
    return undefined;
  }
  requireString(model.modelType, issues, `${path}.modelType`, {
    nonEmpty: true,
  });
  requireString(model.provider, issues, `${path}.provider`, { nonEmpty: true });
  requireString(model.prompt, issues, `${path}.prompt`, { nonEmpty: true });
  if (!("response" in model)) {
    pushIssue(issues, "error", `${path}.response`, "is required");
  } else {
    requireString(model.response, issues, `${path}.response`);
  }
  if (typeof model.modelName !== "string" || model.modelName.trim() === "") {
    pushIssue(
      issues,
      "warning",
      `${path}.modelName`,
      "is missing; cost validation may be incomplete",
    );
  }

  if (!Array.isArray(model.messages)) {
    pushIssue(
      issues,
      opts.requireMessageArrays ? "error" : "warning",
      `${path}.messages`,
      "should contain the full chat messages sent to the provider",
    );
  } else if (model.messages.length === 0) {
    pushIssue(
      issues,
      opts.requireMessageArrays ? "error" : "warning",
      `${path}.messages`,
      "should not be empty",
    );
  }

  const needsToolArrays =
    stage.kind === "planner" || stage.kind === "subPlanner";
  if (!Array.isArray(model.tools)) {
    pushIssue(
      issues,
      needsToolArrays ? "error" : "warning",
      `${path}.tools`,
      "should be present as an array for reviewability",
    );
  } else if (needsToolArrays && model.tools.length === 0) {
    pushIssue(issues, "error", `${path}.tools`, "must include callable tools");
  }
  if (!Array.isArray(model.toolCalls)) {
    pushIssue(
      issues,
      needsToolArrays ? "error" : "warning",
      `${path}.toolCalls`,
      "should be present as an array for reviewability",
    );
  }

  const usage = validateUsage(model.usage, issues, `${path}.usage`);
  if (usage === undefined) {
    pushIssue(
      issues,
      "warning",
      `${path}.usage`,
      "is missing; token and cost rollups cannot be fully audited",
    );
  }
  if (model.costUsd !== undefined) {
    requireNumber(model.costUsd, issues, `${path}.costUsd`, { min: 0 });
  }
  if (usage && typeof model.modelName === "string") {
    const expectedCost = computeCallCostUsd(model.modelName, usage);
    if (
      expectedCost > 0 &&
      typeof model.costUsd === "number" &&
      !nearEqual(model.costUsd, expectedCost, opts.costToleranceUsd ?? 0.000001)
    ) {
      pushIssue(
        issues,
        "error",
        `${path}.costUsd`,
        `does not match price table: expected ${expectedCost}`,
      );
    }
  }

  return model as unknown as ModelCallRecord;
}

function validateStageSequence(
  stages: RecordedStage[],
  issues: ValidationIssue[],
  expectedStages?: string[],
): void {
  if (stages.length === 0) {
    pushIssue(issues, "error", "$.stages", "must contain at least one stage");
    return;
  }
  if (stages[0]?.kind !== "messageHandler") {
    pushIssue(
      issues,
      "error",
      "$.stages[0].kind",
      "first stage must be messageHandler",
    );
  }
  const actualKinds = stages.map((stage) => stage.kind);
  if (expectedStages && expectedStages.length > 0) {
    if (actualKinds.length !== expectedStages.length) {
      pushIssue(
        issues,
        "error",
        "$.stages",
        `expected ${expectedStages.length} stages, found ${actualKinds.length}`,
      );
    }
    for (
      let i = 0;
      i < Math.max(actualKinds.length, expectedStages.length);
      i++
    ) {
      if (actualKinds[i] !== expectedStages[i]) {
        pushIssue(
          issues,
          "error",
          stagePath(i, ".kind"),
          `expected ${expectedStages[i] ?? "<missing>"}, found ${actualKinds[i] ?? "<missing>"}`,
        );
      }
    }
  }

  let seenPlanner = false;
  let sawToolSincePlanner = false;
  const pendingToolCalls: string[] = [];
  const stageIds = new Set<string>();
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (!stage) continue;
    if (stageIds.has(stage.stageId)) {
      pushIssue(issues, "error", stagePath(i, ".stageId"), "must be unique");
    }
    stageIds.add(stage.stageId);

    if (stage.parentStageId && !stageIds.has(stage.parentStageId)) {
      pushIssue(
        issues,
        "warning",
        stagePath(i, ".parentStageId"),
        "does not refer to an earlier stageId",
      );
    }

    if (stage.kind === "messageHandler" && i !== 0) {
      pushIssue(
        issues,
        "error",
        stagePath(i, ".kind"),
        "messageHandler can only appear first",
      );
    }
    if (stage.kind === "planner" || stage.kind === "subPlanner") {
      seenPlanner = true;
      for (const call of stage.model?.toolCalls ?? []) {
        if (call.name) pendingToolCalls.push(call.name);
      }
    }
    if (stage.kind === "tool") {
      if (!seenPlanner) {
        pushIssue(
          issues,
          "error",
          stagePath(i, ".kind"),
          "tool stage must follow a planner/subPlanner stage",
        );
      }
      sawToolSincePlanner = true;
      const toolName = stage.tool?.name;
      if (toolName && pendingToolCalls.length > 0) {
        const idx = pendingToolCalls.indexOf(toolName);
        if (idx >= 0) {
          pendingToolCalls.splice(idx, 1);
        } else {
          pushIssue(
            issues,
            "warning",
            stagePath(i, ".tool.name"),
            "does not match any pending planner toolCall",
          );
        }
      }
    }
    if (stage.kind === "evaluation") {
      if (!sawToolSincePlanner) {
        pushIssue(
          issues,
          "error",
          stagePath(i, ".kind"),
          "evaluation stage must follow a tool result",
        );
      }
      sawToolSincePlanner = false;
    }
  }
}

function extractSelectedContexts(
  stages: RecordedStage[],
  issues: ValidationIssue[],
): string[] {
  const handler = stages.find((stage) => stage.kind === "messageHandler");
  const parsed = parseJsonObject(handler?.model?.response);
  if (!parsed) {
    pushIssue(
      issues,
      "warning",
      "$.stages[0].model.response",
      "messageHandler response is not parseable JSON; context selection cannot be audited",
    );
    return [];
  }
  const contexts = parsed.contexts;
  if (!Array.isArray(contexts)) {
    pushIssue(
      issues,
      "warning",
      "$.stages[0].model.response.contexts",
      "is missing; context selection cannot be audited",
    );
    return [];
  }
  return contexts.filter(
    (context): context is string => typeof context === "string",
  );
}

function validateContextEvidence(
  stages: RecordedStage[],
  selectedContexts: string[],
  issues: ValidationIssue[],
  opts: ValidateTrajectoryOptions,
): void {
  if (opts.requireContextEvidence === false) return;
  const handlerPrompt = stages[0]?.model?.prompt ?? "";
  if (
    !handlerPrompt.includes("available_contexts") &&
    !handlerPrompt.includes("contextRegistryDigest")
  ) {
    pushIssue(
      issues,
      "warning",
      "$.stages[0].model.prompt",
      "lacks available context catalog evidence",
    );
  }
  for (const expected of opts.expectedContexts ?? []) {
    if (!selectedContexts.includes(expected)) {
      pushIssue(
        issues,
        "error",
        "$.stages[0].model.response.contexts",
        `missing expected context "${expected}"`,
      );
    }
  }
  if (selectedContexts.length === 0) return;

  const laterPrompts = stages
    .slice(1)
    .map((stage) => stage.model?.prompt ?? "")
    .filter(Boolean);
  const combined = laterPrompts.join("\n");
  for (const context of selectedContexts) {
    if (!combined.includes(context)) {
      pushIssue(
        issues,
        "warning",
        "$.stages[*].model.prompt",
        `selected context "${context}" is not visible in planner/evaluator prompts`,
      );
    }
  }
  if (
    !combined.includes("selected_contexts") &&
    !combined.includes("selectedContexts")
  ) {
    pushIssue(
      issues,
      "warning",
      "$.stages[*].model.prompt",
      "lacks selected context evidence after Stage 1",
    );
  }
  if (
    !combined.includes("contextProviders") &&
    !combined.includes("contextDefinitions") &&
    !combined.includes("expandedTools") &&
    !combined.includes("provider")
  ) {
    pushIssue(
      issues,
      "warning",
      "$.stages[*].model.prompt",
      "lacks enriched context/provider evidence",
    );
  }
}

function validateMetrics(
  trajectory: RecordedTrajectory,
  rollup: TrajectoryRollup,
  issues: ValidationIssue[],
  opts: ValidateTrajectoryOptions,
): void {
  const metrics = trajectory.metrics as unknown as
    | Record<string, unknown>
    | undefined;
  if (!isRecord(metrics)) {
    pushIssue(issues, "error", "$.metrics", "must be an object");
    return;
  }
  const tolerance = opts.costToleranceUsd ?? 0.000001;
  const checks: Array<[keyof RecordedTrajectoryMetrics, number, number]> = [
    ["totalLatencyMs", rollup.totalLatencyMs, 0],
    ["totalPromptTokens", rollup.totalPromptTokens, 0],
    ["totalCompletionTokens", rollup.totalCompletionTokens, 0],
    ["totalCacheReadTokens", rollup.totalCacheReadTokens, 0],
    ["totalCacheCreationTokens", rollup.totalCacheCreationTokens, 0],
    ["plannerIterations", rollup.plannerIterations, 0],
    ["toolCallsExecuted", rollup.toolCallsExecuted, 0],
    ["toolCallFailures", rollup.toolCallFailures, 0],
    ["evaluatorFailures", rollup.evaluatorFailures, 0],
    ["totalCostUsd", rollup.totalCostUsd, tolerance],
  ];
  for (const [key, expected, metricTolerance] of checks) {
    const actual = metricNumber(metrics, key, issues);
    if (!nearEqual(actual, expected, metricTolerance)) {
      pushIssue(
        issues,
        "error",
        `$.metrics.${key}`,
        `must equal stage rollup ${expected}; found ${actual}`,
      );
    }
  }

  const finalDecision = metrics.finalDecision;
  if (
    finalDecision !== undefined &&
    !["FINISH", "CONTINUE", "max_iterations", "error"].includes(
      String(finalDecision),
    )
  ) {
    pushIssue(
      issues,
      "error",
      "$.metrics.finalDecision",
      "has an invalid value",
    );
  }
  if (trajectory.status === "errored" && finalDecision !== "error") {
    pushIssue(
      issues,
      "warning",
      "$.metrics.finalDecision",
      "errored trajectories should have finalDecision=error",
    );
  }
}

export function rollupTrajectory(
  trajectory: RecordedTrajectory,
): TrajectoryRollup {
  const rollup = cloneRollup();
  for (const stage of trajectory.stages ?? []) {
    rollup.totalLatencyMs += Number.isFinite(stage.latencyMs)
      ? stage.latencyMs
      : 0;
    if (stage.model) {
      rollup.modelCallStages += 1;
      if (stage.model.usage) {
        rollup.totalPromptTokens += stage.model.usage.promptTokens ?? 0;
        rollup.totalCompletionTokens += stage.model.usage.completionTokens ?? 0;
        rollup.totalCacheReadTokens +=
          stage.model.usage.cacheReadInputTokens ?? 0;
        rollup.totalCacheCreationTokens +=
          stage.model.usage.cacheCreationInputTokens ?? 0;
      }
      if (typeof stage.model.costUsd === "number") {
        rollup.totalCostUsd += stage.model.costUsd;
      } else if (stage.model.usage) {
        rollup.totalCostUsd += computeCallCostUsd(
          stage.model.modelName,
          stage.model.usage,
        );
      }
    }
    if (stage.kind === "planner") rollup.plannerIterations += 1;
    if (stage.kind === "tool") {
      rollup.toolCallsExecuted += 1;
      if (stage.tool?.success === false) {
        rollup.toolCallFailures += 1;
        rollup.toolResultFailures += 1;
      } else if (stage.tool?.success === true) {
        rollup.toolResultSuccesses += 1;
      }
    }
    if (stage.kind === "evaluation") {
      rollup.evaluatorStages += 1;
      if (stage.evaluation?.success === false) rollup.evaluatorFailures += 1;
      if (stage.evaluation?.success === true) rollup.evaluatorSuccesses += 1;
    }
  }
  return rollup;
}

export function validateTrajectory(
  value: unknown,
  opts: ValidateTrajectoryOptions = {},
): TrajectoryValidationResult {
  const issues: ValidationIssue[] = [];
  const rollup = cloneRollup();

  if (!isRecord(value)) {
    pushIssue(issues, "error", "$", "must be an object");
    return finalizeValidation(issues, rollup, [], []);
  }

  requireString(value.trajectoryId, issues, "$.trajectoryId", {
    nonEmpty: true,
  });
  requireString(value.agentId, issues, "$.agentId", { nonEmpty: true });
  if (value.roomId !== undefined)
    requireString(value.roomId, issues, "$.roomId");
  if (!isRecord(value.rootMessage)) {
    pushIssue(issues, "error", "$.rootMessage", "must be an object");
  } else {
    requireString(value.rootMessage.id, issues, "$.rootMessage.id", {
      nonEmpty: true,
    });
    requireString(value.rootMessage.text, issues, "$.rootMessage.text");
  }
  requireNumber(value.startedAt, issues, "$.startedAt", { min: 0 });
  if (value.endedAt !== undefined)
    requireNumber(value.endedAt, issues, "$.endedAt", { min: 0 });
  if (!["running", "finished", "errored"].includes(String(value.status))) {
    pushIssue(
      issues,
      "error",
      "$.status",
      "must be running, finished, or errored",
    );
  }
  if (!Array.isArray(value.stages)) {
    pushIssue(issues, "error", "$.stages", "must be an array");
    return finalizeValidation(issues, rollup, [], []);
  }

  const stages = value.stages as RecordedStage[];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i] as unknown;
    const path = stagePath(i);
    if (!isRecord(stage)) {
      pushIssue(issues, "error", path, "must be an object");
      continue;
    }
    requireString(stage.stageId, issues, `${path}.stageId`, { nonEmpty: true });
    if (!STAGE_KINDS.has(stage.kind as RecordedStageKind)) {
      pushIssue(issues, "error", `${path}.kind`, "has an invalid stage kind");
    }
    requireNumber(stage.startedAt, issues, `${path}.startedAt`, { min: 0 });
    requireNumber(stage.endedAt, issues, `${path}.endedAt`, { min: 0 });
    requireNumber(stage.latencyMs, issues, `${path}.latencyMs`, { min: 0 });
    if (
      typeof stage.startedAt === "number" &&
      typeof stage.endedAt === "number" &&
      typeof stage.latencyMs === "number" &&
      stage.endedAt - stage.startedAt !== stage.latencyMs
    ) {
      pushIssue(
        issues,
        "warning",
        `${path}.latencyMs`,
        "does not equal endedAt - startedAt",
      );
    }

    const typedStage = stage as unknown as RecordedStage;
    if (MODEL_STAGE_KINDS.has(typedStage.kind) && typedStage.kind !== "tool") {
      validateModel(stage.model, typedStage, i, issues, opts);
    }
    if (typedStage.kind === "tool") {
      if (!isRecord(stage.tool)) {
        pushIssue(
          issues,
          "error",
          `${path}.tool`,
          "is required for tool stages",
        );
      } else {
        requireString(stage.tool.name, issues, `${path}.tool.name`, {
          nonEmpty: true,
        });
        if (!isRecord(stage.tool.args)) {
          pushIssue(issues, "error", `${path}.tool.args`, "must be an object");
        }
        if (!("result" in stage.tool)) {
          pushIssue(issues, "error", `${path}.tool.result`, "is required");
        }
        if (typeof stage.tool.success !== "boolean") {
          pushIssue(
            issues,
            "error",
            `${path}.tool.success`,
            "must be a boolean",
          );
        }
        requireNumber(
          stage.tool.durationMs,
          issues,
          `${path}.tool.durationMs`,
          {
            min: 0,
          },
        );
      }
    }
    if (typedStage.kind === "evaluation") {
      if (!isRecord(stage.evaluation)) {
        pushIssue(
          issues,
          "error",
          `${path}.evaluation`,
          "is required for evaluation stages",
        );
      } else {
        if (typeof stage.evaluation.success !== "boolean") {
          pushIssue(
            issues,
            "error",
            `${path}.evaluation.success`,
            "must be a boolean",
          );
        }
        requireString(
          stage.evaluation.decision,
          issues,
          `${path}.evaluation.decision`,
          {
            nonEmpty: true,
          },
        );
      }
    }
    if (stage.cache !== undefined) {
      if (!isRecord(stage.cache)) {
        pushIssue(issues, "error", `${path}.cache`, "must be an object");
      } else {
        if (!Array.isArray(stage.cache.segmentHashes)) {
          pushIssue(
            issues,
            "error",
            `${path}.cache.segmentHashes`,
            "must be an array",
          );
        }
        requireString(
          stage.cache.prefixHash,
          issues,
          `${path}.cache.prefixHash`,
          {
            nonEmpty: true,
          },
        );
      }
    } else if (
      typedStage.kind === "planner" ||
      typedStage.kind === "subPlanner"
    ) {
      pushIssue(
        issues,
        "warning",
        `${path}.cache`,
        "is missing; cache segment diffs cannot be reviewed",
      );
    }
  }

  const trajectory = value as unknown as RecordedTrajectory;
  const computedRollup = rollupTrajectory(trajectory);
  validateStageSequence(trajectory.stages, issues, opts.expectedStages);
  validateMetrics(trajectory, computedRollup, issues, opts);
  const selectedContexts = extractSelectedContexts(trajectory.stages, issues);
  validateContextEvidence(trajectory.stages, selectedContexts, issues, opts);

  return finalizeValidation(
    issues,
    computedRollup,
    selectedContexts,
    trajectory.stages.map((stage) => stage.kind),
  );
}

function finalizeValidation(
  issues: ValidationIssue[],
  rollup: TrajectoryRollup,
  selectedContexts: string[],
  stageKinds: string[],
): TrajectoryValidationResult {
  const errorCount = issues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const warningCount = issues.filter(
    (issue) => issue.severity === "warning",
  ).length;
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    issues,
    rollup,
    selectedContexts,
    stageKinds,
  };
}

export function validateTrajectoryJsonReport(
  body: string,
  opts: ValidateTrajectoryOptions = {},
): TrajectoryValidationResult {
  try {
    return validateTrajectory(JSON.parse(body), opts);
  } catch (err) {
    const rollup = cloneRollup();
    return finalizeValidation(
      [
        {
          severity: "error",
          path: "$",
          message: `invalid JSON report: ${(err as Error).message}`,
        },
      ],
      rollup,
      [],
      [],
    );
  }
}

export function validateTrajectoryMarkdownReport(
  body: string,
  trajectory: RecordedTrajectory,
): TrajectoryValidationResult {
  const issues: ValidationIssue[] = [];
  const rollup = rollupTrajectory(trajectory);
  if (!body.includes(`# Trajectory ${trajectory.trajectoryId}`)) {
    pushIssue(issues, "error", "$.markdown", "missing trajectory heading");
  }
  if (!body.includes(`root message:`)) {
    pushIssue(issues, "error", "$.markdown", "missing root message");
  }
  for (const [idx, stage] of trajectory.stages.entries()) {
    const heading = `## Stage ${idx + 1}: ${stage.kind}`;
    const headingIndex = body.indexOf(heading);
    if (headingIndex < 0) {
      pushIssue(
        issues,
        "error",
        `$.markdown.stages[${idx}]`,
        "missing stage heading",
      );
    }
    const nextHeadingIndex = body.indexOf("\n## Stage ", headingIndex + 1);
    const stageBody =
      headingIndex >= 0
        ? body.slice(
            headingIndex,
            nextHeadingIndex >= 0 ? nextHeadingIndex : undefined,
          )
        : "";
    if (stage.model) {
      for (const label of [
        "PROMPT:",
        "RESPONSE:",
        "MESSAGES:",
        "TOOLS:",
        "TOOL_CALLS:",
      ]) {
        if (!stageBody.includes(label)) {
          pushIssue(
            issues,
            "error",
            `$.markdown.stages[${idx}]`,
            `missing ${label} block`,
          );
        }
      }
    }
    if (stage.tool && !stageBody.includes(`tool \`${stage.tool.name}\``)) {
      pushIssue(
        issues,
        "error",
        `$.markdown.stages[${idx}]`,
        "missing tool result block",
      );
    }
    if (stage.evaluation && !stageBody.includes("evaluation:")) {
      pushIssue(
        issues,
        "error",
        `$.markdown.stages[${idx}]`,
        "missing evaluation block",
      );
    }
  }
  return finalizeValidation(
    issues,
    rollup,
    extractSelectedContexts(trajectory.stages, issues),
    trajectory.stages.map((stage) => stage.kind),
  );
}

export function validateTrajectoryExportReport(
  format: "markdown" | "json",
  body: string,
  trajectory: RecordedTrajectory,
): TrajectoryValidationResult {
  if (format === "json") return validateTrajectoryJsonReport(body);
  return validateTrajectoryMarkdownReport(body, trajectory);
}

export function compareTrajectories(
  a: RecordedTrajectory,
  b: RecordedTrajectory,
): CompareTrajectorySummary {
  const rollupA = rollupTrajectory(a);
  const rollupB = rollupTrajectory(b);
  const delta: TrajectoryRollup = {
    totalLatencyMs: numberDelta(rollupA.totalLatencyMs, rollupB.totalLatencyMs),
    totalPromptTokens: numberDelta(
      rollupA.totalPromptTokens,
      rollupB.totalPromptTokens,
    ),
    totalCompletionTokens: numberDelta(
      rollupA.totalCompletionTokens,
      rollupB.totalCompletionTokens,
    ),
    totalCacheReadTokens: numberDelta(
      rollupA.totalCacheReadTokens,
      rollupB.totalCacheReadTokens,
    ),
    totalCacheCreationTokens: numberDelta(
      rollupA.totalCacheCreationTokens,
      rollupB.totalCacheCreationTokens,
    ),
    totalCostUsd: numberDelta(rollupA.totalCostUsd, rollupB.totalCostUsd),
    plannerIterations: numberDelta(
      rollupA.plannerIterations,
      rollupB.plannerIterations,
    ),
    toolCallsExecuted: numberDelta(
      rollupA.toolCallsExecuted,
      rollupB.toolCallsExecuted,
    ),
    toolCallFailures: numberDelta(
      rollupA.toolCallFailures,
      rollupB.toolCallFailures,
    ),
    evaluatorStages: numberDelta(
      rollupA.evaluatorStages,
      rollupB.evaluatorStages,
    ),
    evaluatorSuccesses: numberDelta(
      rollupA.evaluatorSuccesses,
      rollupB.evaluatorSuccesses,
    ),
    evaluatorFailures: numberDelta(
      rollupA.evaluatorFailures,
      rollupB.evaluatorFailures,
    ),
    modelCallStages: numberDelta(
      rollupA.modelCallStages,
      rollupB.modelCallStages,
    ),
    toolResultSuccesses: numberDelta(
      rollupA.toolResultSuccesses,
      rollupB.toolResultSuccesses,
    ),
    toolResultFailures: numberDelta(
      rollupA.toolResultFailures,
      rollupB.toolResultFailures,
    ),
  };
  return {
    idA: a.trajectoryId,
    idB: b.trajectoryId,
    a: rollupA,
    b: rollupB,
    delta,
    cacheHitRateA: cacheHitRate(rollupA),
    cacheHitRateB: cacheHitRate(rollupB),
    cacheHitRateDelta: cacheHitRate(rollupB) - cacheHitRate(rollupA),
    estimatedBatchingDelta: {
      modelCalls: delta.modelCallStages,
      plannerIterations: delta.plannerIterations,
      stages: b.stages.length - a.stages.length,
      toolCalls: delta.toolCallsExecuted,
    },
  };
}

export function cacheHitRate(rollup: TrajectoryRollup): number {
  if (rollup.totalPromptTokens <= 0) return 0;
  return rollup.totalCacheReadTokens / rollup.totalPromptTokens;
}
