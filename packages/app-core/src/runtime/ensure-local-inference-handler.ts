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
import type { LocalInferenceLoader } from "../services/local-inference/active-model";
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

function getLoader(runtime: IAgentRuntime): LocalInferenceLoader | null {
  const candidate = (
    runtime as { getService?: (name: string) => unknown }
  ).getService?.("localInferenceLoader");
  if (!candidate || typeof candidate !== "object") return null;
  const loader = candidate as Partial<LocalInferenceLoader>;
  if (
    typeof loader.loadModel === "function" &&
    typeof loader.unloadModel === "function"
  ) {
    return candidate as LocalInferenceLoader;
  }
  return null;
}

function makeHandler(modelLabel: "small" | "large"): GenerateTextHandler {
  return async (runtime, params) => {
    // Prefer a runtime-registered loader that implements `generate` — that's
    // the mobile path (Capacitor llama.cpp). On desktop we fall back to the
    // standalone engine.
    const loader = getLoader(runtime);
    if (loader?.generate) {
      return loader.generate({
        prompt: params.prompt,
        stopSequences: params.stopSequences,
      });
    }
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

async function tryRegisterCapacitorLoader(
  runtime: AgentRuntime,
): Promise<boolean> {
  // Only meaningful under Capacitor (iOS/Android). Dynamic import so web /
  // desktop bundlers don't choke on the native plugin metadata.
  const cap = (globalThis as Record<string, unknown>).Capacitor as
    | { isNativePlatform?: () => boolean }
    | undefined;
  if (!cap?.isNativePlatform?.()) return false;
  try {
    const mod = (await import("@elizaos/capacitor-llama")) as unknown as {
      registerCapacitorLlamaLoader?: (r: AgentRuntime) => void;
    };
    if (typeof mod.registerCapacitorLlamaLoader === "function") {
      mod.registerCapacitorLlamaLoader(runtime);
      logger.info(
        "[local-inference] Registered capacitor-llama loader for mobile on-device inference",
      );
      return true;
    }
  } catch (err) {
    logger.debug(
      "[local-inference] capacitor-llama not available:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return false;
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

  // Mobile: prefer the Capacitor llama.cpp loader when running natively.
  // Desktop / server: use the standalone node-llama-cpp engine. Both paths
  // satisfy the same `localInferenceLoader` service contract, so the rest
  // of the runtime doesn't care which is active.
  const capacitorRegistered = await tryRegisterCapacitorLoader(runtime);

  // Pre-flight: if neither path is available, skip handler registration
  // entirely so we don't advertise a handler that will throw.
  if (!capacitorRegistered && !(await localInferenceEngine.available())) {
    logger.debug(
      "[local-inference] No local inference backend available; skipping model registration",
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
