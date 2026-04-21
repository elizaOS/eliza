/**
 * Prompt optimization layer for eliza.
 *
 * Wraps `runtime.useModel()` to apply context-aware action compaction
 * and optional prompt tracing/capture. Controlled via ELIZA_* env vars.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AgentRuntime, getTrajectoryContext } from "@elizaos/core";
import { detectRuntimeModel } from "../api/agent-model.js";

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
          ? (calls[calls.length - 1] as Record<string, unknown>)
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

      const applyMissingNumber = (key: string): void => {
        const nextValue = toOptionalNumber(patch[key]);
        if (nextValue === undefined) return;
        const currentValue = toOptionalNumber(latestCall[key]);
        if (currentValue !== undefined && currentValue > 0) return;
        latestCall[key] = nextValue;
        updated = true;
      };

      applyMissingNumber("temperature");
      applyMissingNumber("maxTokens");
      applyMissingNumber("latencyMs");
      applyMissingNumber("promptTokens");
      applyMissingNumber("completionTokens");

      const enriched = enrichTrajectoryLlmCall(latestCall);
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

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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

export function installPromptOptimizations(runtime: AgentRuntime): void {
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
      return originalUseModel(...args);
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
      return originalUseModel(...args);
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

    // Preserve exact model input while a trajectory is active so trajectory
    // detail views and RL exports keep the full prompt instead of the
    // compacted/debug-optimized version.
    if (isTextLarge && !shouldPreserveFullPromptForTrajectoryCapture()) {
      // --- Context-aware action compaction (when enabled) ---
      // Strips <params> from actions not relevant to the user's intent.
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
      let nextPrompt = workingPrompt;
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

      if (nextPrompt !== originalPrompt) {
        const rewrittenPayload = {
          ...(payload as Record<string, unknown>),
          [promptKey]: nextPrompt,
        };
        rewrittenArgs = [
          args[0],
          rewrittenPayload as Parameters<typeof originalUseModel>[1],
          ...args.slice(2),
        ] as Parameters<typeof originalUseModel>;
      }
    }

    const result = await originalUseModel(...rewrittenArgs);
    const responseText = stringifyTrajectoryResponse(result);
    const payloadRecord = rewrittenArgs[1] as Record<string, unknown>;
    const systemPrompt =
      typeof payloadRecord.system === "string"
        ? payloadRecord.system
        : typeof runtime.character?.system === "string"
          ? runtime.character.system
          : "";
    const fallbackCall = {
      stepId: normalizedTrajectoryStepId ?? undefined,
      model: resolveTrajectoryModelLabel(
        runtime,
        modelType,
        payloadRecord,
        args[2],
      ),
      systemPrompt,
      userPrompt: originalPrompt,
      response: responseText,
      temperature:
        typeof payloadRecord.temperature === "number"
          ? payloadRecord.temperature
          : 0,
      maxTokens:
        typeof payloadRecord.maxTokens === "number"
          ? payloadRecord.maxTokens
          : 0,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: Math.max(0, Date.now() - startedAt),
      promptTokens: estimateTokenCount(systemPrompt + originalPrompt),
      completionTokens: estimateTokenCount(responseText),
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
