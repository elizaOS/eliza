/**
 * Registers the standalone llama.cpp engine as the runtime handler for
 * `ModelType.TEXT_SMALL` and `ModelType.TEXT_LARGE` when no higher-priority
 * provider has claimed those slots.
 *
 * Priority is 0 — any cloud or plugin-local-ai provider with a higher value
 * wins. That keeps this strictly additive: if the user has OpenAI /
 * Anthropic / plugin-local-ai configured, those still take the request, and
 * the local engine only fills in when nothing else is available.
 *
 * Parallels `ensure-text-to-speech-handler.ts` — same shape, same guards.
 */

import {
  type AgentRuntime,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  ModelType,
} from "@elizaos/core";
import { localInferenceEngine } from "../services/local-inference/engine";

type GenerateTextHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams,
) => Promise<string>;

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (modelType: string | number) => GenerateTextHandler | undefined;
  registerModel: (
    modelType: string | number,
    handler: GenerateTextHandler,
    provider: string,
    priority?: number,
  ) => void;
};

const LOCAL_INFERENCE_PROVIDER = "milady-local-inference";
const LOCAL_INFERENCE_PRIORITY = 0;

function makeHandler(modelLabel: "small" | "large"): GenerateTextHandler {
  return async (_runtime, params) => {
    if (!(await localInferenceEngine.available())) {
      throw new Error(
        `[local-inference] No llama.cpp binding available for ${modelLabel} model request`,
      );
    }
    if (!localInferenceEngine.hasLoadedModel()) {
      throw new Error(
        "[local-inference] No local model is active. Activate one in Settings → Local models.",
      );
    }
    return localInferenceEngine.generate({
      prompt: params.prompt,
      stopSequences: params.stopSequences,
    });
  };
}

export async function ensureLocalInferenceHandler(
  runtime: AgentRuntime,
): Promise<void> {
  const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
  if (
    typeof runtimeWithRegistration.getModel !== "function" ||
    typeof runtimeWithRegistration.registerModel !== "function"
  ) {
    return;
  }

  // Pre-flight: if the binding isn't installed in this build, skip
  // registration entirely so we don't advertise a handler that will throw.
  if (!(await localInferenceEngine.available())) {
    logger.debug(
      "[local-inference] node-llama-cpp binding not available; skipping model registration",
    );
    return;
  }

  for (const [modelType, label] of [
    [ModelType.TEXT_SMALL, "small"] as const,
    [ModelType.TEXT_LARGE, "large"] as const,
  ]) {
    try {
      runtimeWithRegistration.registerModel(
        modelType,
        makeHandler(label),
        LOCAL_INFERENCE_PROVIDER,
        LOCAL_INFERENCE_PRIORITY,
      );
    } catch (err) {
      logger.warn(
        "[local-inference] Could not register ModelType",
        modelType,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  logger.info(
    `[local-inference] Registered local llama.cpp handler for TEXT_SMALL / TEXT_LARGE at priority ${LOCAL_INFERENCE_PRIORITY}`,
  );
}
