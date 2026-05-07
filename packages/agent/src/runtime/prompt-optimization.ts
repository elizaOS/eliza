/**
 * Prompt optimization layer for eliza.
 *
 * Wraps `runtime.useModel()` to apply context-aware action compaction
 * and optional prompt tracing/capture. Controlled via ELIZA_* env vars.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentRuntime,
  assertActiveTrajectoryForLlmCall,
  EventType,
  getTrajectoryContext,
  isLlmGenerationModelType,
  normalizeTrajectoryLlmPurpose,
} from "@elizaos/core";
import { detectRuntimeModel } from "../api/agent-model.js";
import {
  type ModelTokenMetadata,
  resolveModelTokenMetadata,
} from "../config/model-metadata.js";
import type { ElizaConfig } from "../config/types.js";

import type { TrajectoryLlmCall } from "../types/trajectory.js";
import {
  compactActionsForIntent,
  compactCodingExamplesForIntent,
  compactConversationHistory,
  compactModelPrompt,
  validateIntentActionMap,
} from "./prompt-compaction.js";
import {
  enrichTrajectoryLlmCall,
  ensureTrajectoriesTable,
  isLegacyTrajectoryLogger,
  loadTrajectoryByStepId,
  saveTrajectory,
  toOptionalNumber,
  toText,
} from "./trajectory-internals.js";

export {
  buildFullParamActionSet,
  compactActionsForIntent,
  detectIntentCategories,
} from "./prompt-compaction.js";

// ---------------------------------------------------------------------------
// Env-var driven configuration (evaluated once at import time)
// ---------------------------------------------------------------------------

const ELIZA_PROMPT_OPT_MODE = (
  process.env.ELIZA_PROMPT_OPT_MODE ?? "baseline"
).toLowerCase();

const ELIZA_PROMPT_TRACE =
  process.env.ELIZA_PROMPT_TRACE === "1" ||
  process.env.ELIZA_PROMPT_TRACE?.toLowerCase() === "true";

/**
 * Dump raw prompts to .tmp/prompt-captures/ for analysis. Dev-only.
 * WARNING: captures contain full conversation content including user messages.
 */
const ELIZA_CAPTURE_PROMPTS =
  process.env.ELIZA_CAPTURE_PROMPTS === "1" ||
  process.env.ELIZA_CAPTURE_PROMPTS?.toLowerCase() === "true";

let promptCaptureSeq = 0;

/** When false, context-aware action compaction is skipped entirely. Default: enabled. */
const ELIZA_ACTION_COMPACTION = (() => {
  const raw = process.env.ELIZA_ACTION_COMPACTION?.toLowerCase();
  if (raw === "0" || raw === "false") return false;
  return true;
})();

// Track which runtimes have been wrapped to prevent double-installation.
const installedRuntimes = new WeakSet<AgentRuntime>();
const usageCaptureInstalledRuntimes = new WeakSet<AgentRuntime>();
const usageCaptureStacks = new WeakMap<AgentRuntime, ModelUsageAccumulator[]>();
const runtimeModelConfigs = new WeakMap<AgentRuntime, ElizaConfig>();
const trackedTrajectoryLoggers = new WeakSet<object>();
const trajectoryLlmLogCounts = new WeakMap<AgentRuntime, Map<string, number>>();
const TRAJECTORY_CONTEXT_MANAGER_KEY = Symbol.for(
  "elizaos.trajectoryContextManager",
);

type GlobalWithTrajectoryContextManager = typeof globalThis & {
  [TRAJECTORY_CONTEXT_MANAGER_KEY]?: {
    active: () => { trajectoryStepId?: string } | undefined;
  };
};

type TrajectoryLoggerLike = {
  logLlmCall?: (...args: unknown[]) => unknown;
  logProviderAccess?: (...args: unknown[]) => unknown;
  getLlmCallLogs?: () => readonly unknown[];
  getProviderAccessLogs?: () => readonly unknown[];
  updateLatestLlmCall?: (
    stepId: string,
    patch: Record<string, unknown>,
  ) => Promise<void> | void;
};

type RuntimeWithTrajectoryService = AgentRuntime & {
  getService?: (serviceType: string) => unknown;
  getServicesByType?: (serviceType: string) => unknown;
};

type RuntimeWithEmitEvent = AgentRuntime & {
  emitEvent: (event: unknown, params?: unknown) => Promise<void> | void;
};

export interface CapturedModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
  provider?: string;
  isEstimated: boolean;
  llmCalls: number;
}

interface ModelUsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
  provider?: string;
  isEstimated: boolean;
}

interface ModelUsageAccumulator {
  records: ModelUsageRecord[];
}

interface PromptBudget {
  metadata: ModelTokenMetadata;
  outputReserveTokens: number;
  promptBudgetTokens: number;
}

export interface PromptBudgetResult {
  prompt: string;
  originalPromptTokens: number;
  promptTokens: number;
  budgetTokens: number;
  truncated: boolean;
}

export function shouldPreserveFullPromptForTrajectoryCapture(): boolean {
  return getActiveTrajectoryStepId() !== null;
}

function getSharedTrajectoryStepId(): string | null {
  const stepId = (globalThis as GlobalWithTrajectoryContextManager)[
    TRAJECTORY_CONTEXT_MANAGER_KEY
  ]?.active?.()?.trajectoryStepId;
  return typeof stepId === "string" && stepId.trim().length > 0
    ? stepId.trim()
    : null;
}

function getActiveTrajectoryStepId(): string | null {
  const coreStepId = getTrajectoryContext()?.trajectoryStepId;
  if (typeof coreStepId === "string" && coreStepId.trim().length > 0) {
    return coreStepId.trim();
  }

  return getSharedTrajectoryStepId();
}

function extractTrajectoryStepIdFromLoggerArgs(args: unknown[]): string | null {
  if (args.length === 0) return null;
  const first = args[0];
  if (typeof first === "string") {
    const stepId = first.trim();
    return stepId.length > 0 ? stepId : null;
  }
  if (!first || typeof first !== "object") return null;
  const stepId = (first as { stepId?: unknown }).stepId;
  return typeof stepId === "string" && stepId.trim().length > 0
    ? stepId.trim()
    : null;
}

function getTrajectoryLlmLogCount(
  runtime: AgentRuntime,
  stepId: string,
): number {
  return trajectoryLlmLogCounts.get(runtime)?.get(stepId) ?? 0;
}

function incrementTrajectoryLlmLogCount(
  runtime: AgentRuntime,
  stepId: string,
): void {
  const counts =
    trajectoryLlmLogCounts.get(runtime) ?? new Map<string, number>();
  counts.set(stepId, (counts.get(stepId) ?? 0) + 1);
  trajectoryLlmLogCounts.set(runtime, counts);
}

function resolveTrajectoryLogger(
  runtime: AgentRuntime,
): TrajectoryLoggerLike | null {
  const runtimeWithService = runtime as RuntimeWithTrajectoryService;
  const candidates: TrajectoryLoggerLike[] = [];
  const seen = new Set<unknown>();
  const push = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate as TrajectoryLoggerLike);
  };

  if (typeof runtimeWithService.getServicesByType === "function") {
    const byType = runtimeWithService.getServicesByType("trajectories");
    if (Array.isArray(byType)) {
      for (const candidate of byType) {
        push(candidate);
      }
    } else {
      push(byType);
    }
  }

  if (typeof runtimeWithService.getService === "function") {
    push(runtimeWithService.getService("trajectories"));
  }

  if (candidates.length === 0) return null;

  let best: TrajectoryLoggerLike | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    let score = 0;
    if (isLegacyTrajectoryLogger(candidate)) score += 100;
    if (typeof candidate.logLlmCall === "function") score += 10;
    if (typeof candidate.logProviderAccess === "function") score += 10;
    if (typeof candidate.getLlmCallLogs === "function") score += 2;
    if (typeof candidate.getProviderAccessLogs === "function") score += 2;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function ensureTrajectoryLoggerTracking(
  runtime: AgentRuntime,
): TrajectoryLoggerLike | null {
  const trajectoryLogger = resolveTrajectoryLogger(runtime);
  if (!trajectoryLogger) {
    return trajectoryLogger;
  }

  if (typeof trajectoryLogger.updateLatestLlmCall !== "function") {
    trajectoryLogger.updateLatestLlmCall = async (
      stepId: string,
      patch: Record<string, unknown>,
    ) => {
      const normalizedStepId = stepId.trim();
      if (!normalizedStepId) return;

      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;

      const trajectory = await loadTrajectoryByStepId(
        runtime,
        normalizedStepId,
      );
      if (!trajectory || !Array.isArray(trajectory.steps)) return;

      const step =
        [...trajectory.steps]
          .reverse()
          .find((candidate) => candidate.stepId === normalizedStepId) ??
        trajectory.steps[trajectory.steps.length - 1];
      const calls = Array.isArray(step?.llmCalls) ? step.llmCalls : [];
      const latestCall =
        calls.length > 0
          ? (calls[calls.length - 1] as TrajectoryLlmCall)
          : null;
      if (!latestCall) return;

      let updated = false;
      const nextModel = toText(patch.model, "").trim();
      const currentModel = toText(latestCall.model, "").trim();
      if (
        nextModel &&
        currentModel !== nextModel &&
        (currentModel.length === 0 ||
          isGenericTrajectoryModel(currentModel) ||
          !isGenericTrajectoryModel(nextModel))
      ) {
        latestCall.model = nextModel;
        updated = true;
      }

      const nextSystemPrompt = toText(patch.systemPrompt, "");
      if (!toText(latestCall.systemPrompt, "") && nextSystemPrompt) {
        latestCall.systemPrompt = nextSystemPrompt;
        updated = true;
      }

      const nextUserPrompt = toText(patch.userPrompt, "");
      if (!toText(latestCall.userPrompt, "") && nextUserPrompt) {
        latestCall.userPrompt = nextUserPrompt;
        updated = true;
      }

      const nextResponse = toText(patch.response, "");
      if (!toText(latestCall.response, "") && nextResponse) {
        latestCall.response = nextResponse;
        updated = true;
      }

      type NumericLlmCallField =
        | "temperature"
        | "maxTokens"
        | "latencyMs"
        | "promptTokens"
        | "completionTokens";

      function readExistingNumeric(
        call: TrajectoryLlmCall,
        key: NumericLlmCallField,
      ) {
        switch (key) {
          case "temperature":
            return call.temperature;
          case "maxTokens":
            return call.maxTokens;
          case "latencyMs":
            return call.latencyMs;
          case "promptTokens":
            return call.promptTokens;
          case "completionTokens":
            return call.completionTokens;
          default: {
            const _exhaustive: never = key;
            return _exhaustive;
          }
        }
      }

      function writeNumeric(
        call: TrajectoryLlmCall,
        key: NumericLlmCallField,
        value: number,
      ) {
        switch (key) {
          case "temperature":
            call.temperature = value;
            break;
          case "maxTokens":
            call.maxTokens = value;
            break;
          case "latencyMs":
            call.latencyMs = value;
            break;
          case "promptTokens":
            call.promptTokens = value;
            break;
          case "completionTokens":
            call.completionTokens = value;
            break;
          default: {
            const _exhaustive: never = key;
            return _exhaustive;
          }
        }
      }

      const applyMissingNumber = (key: NumericLlmCallField): void => {
        const rawPatch = (patch as Record<string, unknown>)[key];
        const nextValue = toOptionalNumber(rawPatch);
        if (nextValue === undefined) return;
        const currentValue = toOptionalNumber(
          readExistingNumeric(latestCall, key),
        );
        if (currentValue !== undefined && currentValue > 0) return;
        writeNumeric(latestCall, key, nextValue);
        updated = true;
      };

      applyMissingNumber("temperature");
      applyMissingNumber("maxTokens");
      applyMissingNumber("latencyMs");
      applyMissingNumber("promptTokens");
      applyMissingNumber("completionTokens");

      if (typeof patch.tokenUsageEstimated === "boolean") {
        const currentEstimated = latestCall.tokenUsageEstimated;
        if (
          typeof currentEstimated !== "boolean" ||
          (currentEstimated && !patch.tokenUsageEstimated)
        ) {
          latestCall.tokenUsageEstimated = patch.tokenUsageEstimated;
          updated = true;
        }
      }

      const enriched = enrichTrajectoryLlmCall(
        latestCall as Record<string, unknown>,
      );
      const nextStepType = toText(enriched.stepType, "");
      if (nextStepType && toText(latestCall.stepType, "") !== nextStepType) {
        latestCall.stepType = nextStepType;
        updated = true;
      }

      const nextTags = Array.isArray(enriched.tags)
        ? enriched.tags.filter(
            (tag): tag is string => typeof tag === "string" && tag.length > 0,
          )
        : [];
      const currentTags = Array.isArray(latestCall.tags)
        ? latestCall.tags.filter(
            (tag): tag is string => typeof tag === "string" && tag.length > 0,
          )
        : [];
      if (
        nextTags.length > 0 &&
        JSON.stringify(currentTags) !== JSON.stringify(nextTags)
      ) {
        latestCall.tags = nextTags;
        updated = true;
      }

      if (!updated) return;

      trajectory.updatedAt = new Date().toISOString();
      await saveTrajectory(runtime, trajectory);
    };
  }

  if (typeof trajectoryLogger.logLlmCall !== "function") {
    return trajectoryLogger;
  }

  const loggerObject = trajectoryLogger as object;
  if (trackedTrajectoryLoggers.has(loggerObject)) {
    return trajectoryLogger;
  }

  const originalLogLlmCall = trajectoryLogger.logLlmCall.bind(trajectoryLogger);
  trajectoryLogger.logLlmCall = ((...args: unknown[]) => {
    const stepId = extractTrajectoryStepIdFromLoggerArgs(args);
    if (stepId) {
      incrementTrajectoryLlmLogCount(runtime, stepId);
    }
    return originalLogLlmCall(...args);
  }) as typeof trajectoryLogger.logLlmCall;

  trackedTrajectoryLoggers.add(loggerObject);
  return trajectoryLogger;
}

function stringifyTrajectoryResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (response == null) return "";
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function isModelUsedEvent(event: unknown): boolean {
  if (event === EventType.MODEL_USED || event === "MODEL_USED") {
    return true;
  }
  if (Array.isArray(event)) {
    return event.some((entry) => isModelUsedEvent(entry));
  }
  return false;
}

function toUsageModelLabel(
  payload: Record<string, unknown>,
): string | undefined {
  for (const key of ["model", "modelId", "modelName", "type"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeModelUsageRecord(payload: unknown): ModelUsageRecord | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const tokens =
    record.tokens &&
    typeof record.tokens === "object" &&
    !Array.isArray(record.tokens)
      ? (record.tokens as Record<string, unknown>)
      : undefined;
  if (!tokens) return null;

  const promptTokens = toOptionalNumber(tokens.prompt);
  const completionTokens = toOptionalNumber(tokens.completion);
  const totalTokens = toOptionalNumber(tokens.total);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  const normalizedPromptTokens = promptTokens ?? 0;
  const normalizedCompletionTokens =
    completionTokens ??
    Math.max(
      0,
      (totalTokens ?? normalizedPromptTokens) - normalizedPromptTokens,
    );
  const normalizedTotalTokens =
    totalTokens ?? normalizedPromptTokens + normalizedCompletionTokens;
  const provider =
    typeof record.provider === "string" && record.provider.trim().length > 0
      ? record.provider.trim()
      : typeof record.source === "string" && record.source.trim().length > 0
        ? record.source.trim()
        : undefined;

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: normalizedTotalTokens,
    ...(toUsageModelLabel(record) ? { model: toUsageModelLabel(record) } : {}),
    ...(provider ? { provider } : {}),
    isEstimated:
      record.usageEstimated === true ||
      record.estimated === true ||
      tokens.estimated === true,
  };
}

function aggregateModelUsage(
  records: readonly ModelUsageRecord[],
): CapturedModelUsage | null {
  if (records.length === 0) return null;

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let model: string | undefined;
  let provider: string | undefined;
  let isEstimated = false;

  for (const record of records) {
    promptTokens += record.promptTokens;
    completionTokens += record.completionTokens;
    totalTokens += record.totalTokens;
    model = record.model ?? model;
    provider = record.provider ?? provider;
    isEstimated ||= record.isEstimated;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    isEstimated,
    llmCalls: records.length,
  };
}

function ensureModelUsageEventCapture(runtime: AgentRuntime): void {
  if (usageCaptureInstalledRuntimes.has(runtime)) return;
  usageCaptureInstalledRuntimes.add(runtime);

  const runtimeWithEmit = runtime as RuntimeWithEmitEvent;
  if (typeof runtimeWithEmit.emitEvent !== "function") return;

  const originalEmitEvent = runtimeWithEmit.emitEvent.bind(runtime);
  runtimeWithEmit.emitEvent = (async (event: unknown, params?: unknown) => {
    if (isModelUsedEvent(event)) {
      const usageRecord = normalizeModelUsageRecord(params);
      if (usageRecord) {
        for (const accumulator of usageCaptureStacks.get(runtime) ?? []) {
          accumulator.records.push(usageRecord);
        }
      }
    }
    return originalEmitEvent(event, params);
  }) as RuntimeWithEmitEvent["emitEvent"];
}

export async function withModelUsageCapture<T>(
  runtime: AgentRuntime,
  run: () => Promise<T>,
): Promise<{ result: T; usage: CapturedModelUsage | null }> {
  ensureModelUsageEventCapture(runtime);

  const stack = usageCaptureStacks.get(runtime) ?? [];
  const accumulator: ModelUsageAccumulator = { records: [] };
  stack.push(accumulator);
  usageCaptureStacks.set(runtime, stack);

  try {
    const result = await run();
    return {
      result,
      usage: aggregateModelUsage(accumulator.records),
    };
  } finally {
    const index = stack.indexOf(accumulator);
    if (index >= 0) {
      stack.splice(index, 1);
    }
    if (stack.length === 0) {
      usageCaptureStacks.delete(runtime);
    }
  }
}

function resolvePayloadModelId(
  runtime: AgentRuntime,
  modelType: string,
  payloadRecord: Record<string, unknown>,
): string {
  for (const key of ["model", "modelId", "modelName"]) {
    const value = payloadRecord[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const config = runtimeModelConfigs.get(runtime);
  const detected = detectRuntimeModel(runtime, config);
  if (detected && detected.trim().length > 0) {
    return detected.trim();
  }

  return modelType;
}

function resolvePromptBudget(
  runtime: AgentRuntime,
  modelType: string,
  payloadRecord: Record<string, unknown>,
): PromptBudget {
  const metadata = resolveModelTokenMetadata(
    runtimeModelConfigs.get(runtime),
    resolvePayloadModelId(runtime, modelType, payloadRecord),
  );
  const requestedOutputTokens = [
    toOptionalNumber(payloadRecord.maxOutputTokens),
    toOptionalNumber(payloadRecord.maxTokens),
  ].find((value): value is number => value !== undefined && value > 0);
  const outputReserveTokens = Math.min(
    Math.max(1, metadata.contextWindow - 1),
    requestedOutputTokens ?? metadata.maxTokens,
  );
  const promptBudgetTokens = Math.max(
    1,
    Math.floor((metadata.contextWindow - outputReserveTokens) * 0.95),
  );

  return {
    metadata,
    outputReserveTokens,
    promptBudgetTokens,
  };
}

function shouldApplyPromptBudget(modelType: string): boolean {
  if (modelType.includes("EMBEDDING")) return false;
  return (
    modelType.includes("TEXT_") ||
    modelType.includes("REASONING_") ||
    modelType === "RESPONSE_HANDLER" ||
    modelType === "ACTION_PLANNER"
  );
}

function truncatePromptToTokenBudget(
  prompt: string,
  budgetTokens: number,
): string {
  const charBudget = Math.max(0, budgetTokens * 4);
  if (prompt.length <= charBudget) return prompt;
  if (charBudget <= 0) return "";

  const marker =
    "\n\n[... context truncated to fit model context window ...]\n\n";
  const receivedMessageStart = prompt.search(/\n#{1,3}\s*Received Message\b/i);
  const tail =
    receivedMessageStart >= 0
      ? prompt.slice(receivedMessageStart)
      : prompt.slice(-Math.floor(charBudget * 0.7));
  if (tail.length >= charBudget) {
    return tail.slice(-charBudget);
  }

  const headBudget = charBudget - tail.length - marker.length;
  if (headBudget <= 0) {
    return tail.slice(-charBudget);
  }

  return `${prompt.slice(0, headBudget)}${marker}${tail}`;
}

export function fitPromptToTokenBudget(
  prompt: string,
  budgetTokens: number,
): PromptBudgetResult {
  const originalPromptTokens = estimateTokenCount(prompt);
  if (originalPromptTokens <= budgetTokens) {
    return {
      prompt,
      originalPromptTokens,
      promptTokens: originalPromptTokens,
      budgetTokens,
      truncated: false,
    };
  }

  let nextPrompt = compactActionsForIntent(prompt);
  nextPrompt = compactCodingExamplesForIntent(nextPrompt);
  nextPrompt = compactConversationHistory(nextPrompt);
  nextPrompt = compactModelPrompt(nextPrompt);

  let promptTokens = estimateTokenCount(nextPrompt);
  let truncated = false;
  if (promptTokens > budgetTokens) {
    nextPrompt = truncatePromptToTokenBudget(nextPrompt, budgetTokens);
    promptTokens = estimateTokenCount(nextPrompt);
    truncated = true;
  }

  return {
    prompt: nextPrompt,
    originalPromptTokens,
    promptTokens,
    budgetTokens,
    truncated,
  };
}

function isGenericTrajectoryModel(model: string): boolean {
  const normalized = model.trim().toUpperCase();
  return (
    normalized.length === 0 ||
    normalized === "UNKNOWN" ||
    normalized.startsWith("TEXT_") ||
    normalized.startsWith("REASONING_") ||
    normalized.startsWith("OBJECT_")
  );
}

function resolveTrajectoryModelLabel(
  runtime: AgentRuntime,
  modelType: string,
  payloadRecord: Record<string, unknown>,
  providerHint?: unknown,
): string {
  const explicitModel =
    typeof payloadRecord.model === "string"
      ? payloadRecord.model.trim()
      : typeof payloadRecord.modelId === "string"
        ? payloadRecord.modelId.trim()
        : "";
  if (explicitModel) {
    return explicitModel;
  }

  const provider =
    typeof providerHint === "string" && providerHint.trim().length > 0
      ? providerHint.trim()
      : typeof payloadRecord.provider === "string" &&
          payloadRecord.provider.trim().length > 0
        ? payloadRecord.provider.trim()
        : "";
  if (provider) {
    return modelType ? `${provider}/${modelType}` : provider;
  }

  const configuredModel = detectRuntimeModel(runtime);
  if (configuredModel && configuredModel.trim().length > 0) {
    return configuredModel.trim();
  }

  return modelType;
}

// ---------------------------------------------------------------------------
// Public API — install the useModel wrapper on a runtime
// ---------------------------------------------------------------------------

export function installPromptOptimizations(
  runtime: AgentRuntime,
  config?: ElizaConfig,
): void {
  if (config) {
    runtimeModelConfigs.set(runtime, config);
  }
  ensureModelUsageEventCapture(runtime);
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  // Validate intent-action map against registered actions
  const actionNames = runtime.actions?.map((a) => a.name) ?? [];
  if (actionNames.length > 0) {
    validateIntentActionMap(actionNames, runtime.logger);
  }

  const originalUseModel = runtime.useModel.bind(runtime);

  runtime.useModel = (async (...args: Parameters<typeof originalUseModel>) => {
    const modelType = String(args[0] ?? "").toUpperCase();
    const llmPurpose = normalizeTrajectoryLlmPurpose(
      getTrajectoryContext()?.purpose,
      modelType === "ACTION_PLANNER" ? "planner" : "action",
    );
    if (isLlmGenerationModelType(modelType)) {
      assertActiveTrajectoryForLlmCall({
        actionType: "runtime.useModel",
        modelType,
        purpose: llmPurpose,
      });
    }

    const normalizedTrajectoryStepId = getActiveTrajectoryStepId();
    const trajectoryLogger = normalizedTrajectoryStepId
      ? ensureTrajectoryLoggerTracking(runtime)
      : null;
    const llmLogCountBefore = normalizedTrajectoryStepId
      ? getTrajectoryLlmLogCount(runtime, normalizedTrajectoryStepId)
      : 0;
    const startedAt = Date.now();

    const payload = args[1];
    const isTextLarge = modelType.includes("TEXT_LARGE");
    if (!payload || typeof payload !== "object") {
      const { result } = await withModelUsageCapture(runtime, () =>
        originalUseModel(...args),
      );
      return result;
    }

    const promptRecord = payload as Record<string, unknown>;
    const promptKey =
      typeof promptRecord.prompt === "string"
        ? "prompt"
        : typeof promptRecord.userPrompt === "string"
          ? "userPrompt"
          : typeof promptRecord.input === "string"
            ? "input"
            : null;
    if (!promptKey) {
      const { result } = await withModelUsageCapture(runtime, () =>
        originalUseModel(...args),
      );
      return result;
    }

    const originalPrompt = String(promptRecord[promptKey] ?? "");

    // --- Prompt capture (dev debugging) ---
    if (ELIZA_CAPTURE_PROMPTS) {
      const captureDir = path.resolve(".tmp", "prompt-captures");
      const seq = String(++promptCaptureSeq).padStart(4, "0");
      const filename = `${seq}-${modelType}.txt`;
      await mkdir(captureDir, { recursive: true }).catch(() => {});
      await writeFile(
        path.join(captureDir, filename),
        `--- model: ${modelType} | key: ${promptKey} | chars: ${originalPrompt.length} ---\n\n${originalPrompt}`,
      ).catch(() => {});
    }

    let rewrittenArgs = args;
    let nextPrompt = originalPrompt;
    let outputReserveTokens: number | undefined;

    // Skip intent compaction while trajectory capture is active; hard model
    // budgets still apply because providers cannot accept overflow prompts.
    if (isTextLarge && !shouldPreserveFullPromptForTrajectoryCapture()) {
      // --- Context-aware action compaction (when enabled) ---
      // Strips param detail from actions not relevant to the user's intent.
      // All action names remain visible — only param detail is stripped.
      let workingPrompt = ELIZA_ACTION_COMPACTION
        ? compactActionsForIntent(originalPrompt)
        : originalPrompt;

      // Strip coding agent examples when no coding intent is detected.
      // These are ~4k chars of provider-injected examples that are only
      // useful when the user is asking about code/repos/agents.
      if (ELIZA_ACTION_COMPACTION) {
        workingPrompt = compactCodingExamplesForIntent(workingPrompt);
        workingPrompt = compactConversationHistory(workingPrompt);
      }

      // --- Full prompt compaction (compact mode only) ---
      nextPrompt = workingPrompt;
      if (ELIZA_PROMPT_OPT_MODE === "compact") {
        nextPrompt = compactModelPrompt(workingPrompt);
        if (ELIZA_PROMPT_TRACE && nextPrompt.length !== originalPrompt.length) {
          runtime.logger?.info(
            `[eliza] Compact prompt rewrite: ${originalPrompt.length} -> ${nextPrompt.length} chars`,
          );
        }
      } else if (workingPrompt !== originalPrompt && ELIZA_PROMPT_TRACE) {
        runtime.logger?.info(
          `[eliza] Action compaction: ${originalPrompt.length} -> ${workingPrompt.length} chars (saved ${originalPrompt.length - workingPrompt.length})`,
        );
      }
    }

    if (shouldApplyPromptBudget(modelType)) {
      const budget = resolvePromptBudget(runtime, modelType, {
        ...promptRecord,
        [promptKey]: nextPrompt,
      });
      outputReserveTokens = budget.outputReserveTokens;
      const budgetedPrompt = fitPromptToTokenBudget(
        nextPrompt,
        budget.promptBudgetTokens,
      );
      if (budgetedPrompt.prompt !== nextPrompt) {
        nextPrompt = budgetedPrompt.prompt;
        if (ELIZA_PROMPT_TRACE) {
          runtime.logger?.info(
            `[eliza] Budget prompt rewrite (${budget.metadata.source}:${budget.metadata.modelId}): ${budgetedPrompt.originalPromptTokens} -> ${budgetedPrompt.promptTokens} tokens`,
          );
        }
      }
    }

    const shouldSetMaxOutputTokens =
      outputReserveTokens !== undefined &&
      toOptionalNumber(promptRecord.maxOutputTokens) !== undefined;
    const shouldRewritePayload =
      nextPrompt !== originalPrompt ||
      (outputReserveTokens !== undefined &&
        toOptionalNumber(promptRecord.maxTokens) !== outputReserveTokens) ||
      shouldSetMaxOutputTokens;
    if (shouldRewritePayload) {
      const rewrittenPayload = {
        ...(payload as Record<string, unknown>),
        [promptKey]: nextPrompt,
        ...(outputReserveTokens !== undefined
          ? shouldSetMaxOutputTokens
            ? { maxOutputTokens: outputReserveTokens }
            : { maxTokens: outputReserveTokens }
          : {}),
      };
      rewrittenArgs = [
        args[0],
        rewrittenPayload as Parameters<typeof originalUseModel>[1],
        ...args.slice(2),
      ] as Parameters<typeof originalUseModel>;
    }

    const { result, usage: capturedUsage } = await withModelUsageCapture(
      runtime,
      () => originalUseModel(...rewrittenArgs),
    );
    const responseText = stringifyTrajectoryResponse(result);
    const payloadRecord = rewrittenArgs[1] as Record<string, unknown>;
    const systemPrompt =
      typeof payloadRecord.system === "string"
        ? payloadRecord.system
        : typeof runtime.character?.system === "string"
          ? runtime.character.system
          : "";
    const promptTokens =
      capturedUsage?.promptTokens ??
      estimateTokenCount(systemPrompt + String(payloadRecord[promptKey] ?? ""));
    const completionTokens =
      capturedUsage?.completionTokens ?? estimateTokenCount(responseText);
    const fallbackCall = {
      stepId: normalizedTrajectoryStepId ?? undefined,
      model: resolveTrajectoryModelLabel(
        runtime,
        modelType,
        payloadRecord,
        args[2],
      ),
      systemPrompt,
      userPrompt: String(payloadRecord[promptKey] ?? ""),
      response: responseText,
      temperature:
        typeof payloadRecord.temperature === "number"
          ? payloadRecord.temperature
          : 0,
      maxTokens:
        toOptionalNumber(payloadRecord.maxTokens) ??
        toOptionalNumber(payloadRecord.maxOutputTokens) ??
        outputReserveTokens ??
        0,
      purpose: llmPurpose,
      actionType: "runtime.useModel",
      latencyMs: Math.max(0, Date.now() - startedAt),
      promptTokens,
      completionTokens,
      tokenUsageEstimated: !capturedUsage,
    };

    if (
      normalizedTrajectoryStepId &&
      trajectoryLogger &&
      typeof trajectoryLogger.logLlmCall === "function" &&
      getTrajectoryLlmLogCount(runtime, normalizedTrajectoryStepId) ===
        llmLogCountBefore
    ) {
      try {
        trajectoryLogger.logLlmCall(fallbackCall);
        runtime.logger?.warn?.(
          `[eliza] Trajectory logger missed live LLM capture for ${normalizedTrajectoryStepId}; recorded fallback call from prompt optimization wrapper`,
        );
      } catch {
        // Ignore fallback logging failures; the model call itself already succeeded.
      }
    } else if (
      normalizedTrajectoryStepId &&
      trajectoryLogger &&
      typeof trajectoryLogger.updateLatestLlmCall === "function"
    ) {
      try {
        await trajectoryLogger.updateLatestLlmCall(
          normalizedTrajectoryStepId,
          fallbackCall,
        );
      } catch {
        // Ignore enrichment failures; the model call itself already succeeded.
      }
    }

    return result;
  }) as typeof runtime.useModel;
}
