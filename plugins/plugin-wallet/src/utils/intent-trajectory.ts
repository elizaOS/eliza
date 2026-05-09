/**
 * Intent-extraction trajectory helper for plugin-wallet.
 *
 * Wraps `runtime.useModel` calls used for financial-parameter extraction
 * (transfer/swap/bridge/balance intent prompts) with the canonical
 * `recordLlmCall` trajectory recorder so every intent LLM hop lands in
 * the trajectories table for training and audit.
 *
 * Falls back to `logActiveTrajectoryLlmCall` if `recordLlmCall` is not
 * exported by the linked `@elizaos/core` build.
 */

import {
  buildCanonicalSystemPrompt,
  getTrajectoryContext,
  type IAgentRuntime,
  logActiveTrajectoryLlmCall,
  ModelType,
  recordLlmCall,
} from "@elizaos/core";

export type IntentModelType =
  | typeof ModelType.TEXT_LARGE
  | typeof ModelType.TEXT_SMALL;

export interface RunIntentModelParams {
  runtime: IAgentRuntime;
  /** Trajectory `actionType` label. Use a dotted call-site identifier. */
  taskName: string;
  /** Logical purpose; financial intent extraction is "action" by default. */
  purpose?: string;
  /** Composed prompt text passed to the model. */
  template: string;
  /** Defaults to TEXT_LARGE. */
  modelType?: IntentModelType;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Run an intent-extraction LLM call and record it on the active trajectory.
 *
 * Returns the raw model text so callers can continue parsing with their
 * existing JSON pipeline. Uses `recordLlmCall` when available; otherwise
 * runs the model and emits a `logActiveTrajectoryLlmCall` entry directly.
 */
export async function runIntentModel(
  params: RunIntentModelParams,
): Promise<string> {
  const {
    runtime,
    taskName,
    template,
    purpose = "action",
    modelType = ModelType.TEXT_LARGE,
    maxTokens,
    temperature,
  } = params;

  const systemPrompt = buildCanonicalSystemPrompt({
    character: runtime.character,
    userRole: getTrajectoryContext()?.userRole,
  });
  const modelLabel = String(modelType);
  const modelParams = {
    prompt: template,
    system: systemPrompt,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  if (typeof recordLlmCall === "function") {
    return recordLlmCall(
      runtime,
      {
        model: modelLabel,
        systemPrompt,
        userPrompt: template,
        temperature: temperature ?? 0,
        maxTokens: maxTokens ?? 0,
        purpose,
        actionType: taskName,
      },
      async () => {
        const response = await runtime.useModel(modelType, modelParams);
        return typeof response === "string" ? response : String(response ?? "");
      },
    );
  }

  const startedAt = Date.now();
  const response = await runtime.useModel(modelType, modelParams);
  const text = typeof response === "string" ? response : String(response ?? "");
  logActiveTrajectoryLlmCall(runtime, {
    model: modelLabel,
    systemPrompt,
    userPrompt: template,
    response: text,
    temperature: temperature ?? 0,
    maxTokens: maxTokens ?? 0,
    purpose,
    actionType: taskName,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });
  return text;
}
