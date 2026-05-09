import process from "node:process";
import { loadElizaConfig } from "@elizaos/agent";
import { type AgentRuntime, logger, ModelType } from "@elizaos/core";

export interface EdgeTtsConfig {
  plugins?: {
    entries?: {
      "edge-tts"?: {
        enabled?: boolean;
      };
    };
  };
}

export function isEdgeTtsDisabled(config: EdgeTtsConfig): boolean {
  if (config.plugins?.entries?.["edge-tts"]?.enabled === false) {
    return true;
  }

  const raw = process?.env ? process.env.ELIZA_DISABLE_EDGE_TTS : undefined;
  if (!raw || typeof raw !== "string") {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

type TtsModelHandler = (
  runtime: AgentRuntime,
  input: unknown,
) => Promise<unknown>;

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (modelType: string | number) => TtsModelHandler | undefined;
  registerModel: (
    modelType: string | number,
    handler: TtsModelHandler,
    provider: string,
    priority?: number,
  ) => void;
};

type EdgeTtsPluginModule = {
  default?: { models?: Record<string, TtsModelHandler> };
  edgeTTSPlugin?: { models?: Record<string, TtsModelHandler> };
};

function readHandler(
  plugin: EdgeTtsPluginModule["default"],
): TtsModelHandler | undefined {
  const handler = plugin?.models?.[ModelType.TEXT_TO_SPEECH];
  return typeof handler === "function" ? handler : undefined;
}

/**
 * `@elizaos/agent` boot calls its own `collectPluginNames`, so the app wrapper
 * that adds Edge TTS is bypassed. Register the Edge TTS model handler on the
 * live runtime so streaming / swarm voice can still resolve TEXT_TO_SPEECH.
 */
export async function ensureTextToSpeechHandler(
  runtime: AgentRuntime,
): Promise<void> {
  const config = loadElizaConfig();
  if (isEdgeTtsDisabled(config)) {
    return;
  }

  const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
  if (
    typeof runtimeWithRegistration.getModel !== "function" ||
    typeof runtimeWithRegistration.registerModel !== "function"
  ) {
    return;
  }

  const existing = runtimeWithRegistration.getModel(ModelType.TEXT_TO_SPEECH);
  if (existing) {
    return;
  }

  try {
    const nodeModule = (await import(
      "@elizaos/plugin-edge-tts"
    )) as EdgeTtsPluginModule;
    const handler = readHandler(nodeModule.default);

    if (!handler) {
      throw new Error(
        "@elizaos/plugin-edge-tts/node did not expose a TEXT_TO_SPEECH handler",
      );
    }

    runtimeWithRegistration.registerModel(
      ModelType.TEXT_TO_SPEECH,
      handler,
      "edge-tts",
      0,
    );
    logger.info(
      "[eliza] Registered Edge TTS for runtime TEXT_TO_SPEECH (streaming / swarm voice)",
    );
  } catch (error) {
    throw new Error(
      `[eliza] Could not register Edge TTS for TEXT_TO_SPEECH: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
