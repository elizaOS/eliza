import { loadElizaConfig } from "@elizaos/agent";
import { type AgentRuntime, logger, ModelType } from "@elizaos/core";
import { formatError } from "@elizaos/shared";
import { loadDefaultTextToSpeechHandler } from "./tts-default-handler.js";
import {
  DEFAULT_TEXT_TO_SPEECH_PROVIDER,
  isTextToSpeechProviderDisabled,
  resolveDefaultTextToSpeechProvider,
  type TextToSpeechProviderConfig,
  type TtsModelHandler,
} from "./tts-provider-registry.js";

export type EdgeTtsConfig = TextToSpeechProviderConfig;

export function isEdgeTtsDisabled(config: TextToSpeechProviderConfig): boolean {
  return isTextToSpeechProviderDisabled(
    config,
    DEFAULT_TEXT_TO_SPEECH_PROVIDER,
  );
}

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (modelType: string | number) => TtsModelHandler | undefined;
  registerModel: (
    modelType: string | number,
    handler: TtsModelHandler,
    provider: string,
    priority?: number,
  ) => void;
};

/** Register the runtime fallback TTS model for streaming / swarm voice paths. */
export async function ensureTextToSpeechHandler(
  runtime: AgentRuntime,
): Promise<void> {
  const config = loadElizaConfig();
  if (isTextToSpeechProviderDisabled(config, DEFAULT_TEXT_TO_SPEECH_PROVIDER)) {
    return;
  }
  const provider = resolveDefaultTextToSpeechProvider();

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
    const handler = await loadDefaultTextToSpeechHandler();

    // Wrap the TTS handler with the first-sentence LRU cache so short
    // opener phrases like "Got it." / "Sure!" reuse synthesised bytes across
    // turns. The wrapper is a no-op when sqlite is unavailable or
    // `ELIZA_TTS_CACHE_DISABLE=1` is set.
    const wrappedHandler = (await provider.wrapHandler?.(handler)) ?? handler;

    runtimeWithRegistration.registerModel(
      ModelType.TEXT_TO_SPEECH,
      wrappedHandler,
      provider.providerName,
      provider.priority,
    );
    logger.info(
      `[eliza] Registered ${provider.providerName} for runtime TEXT_TO_SPEECH (streaming / swarm voice)`,
    );
  } catch (error) {
    throw new Error(
      `[eliza] Could not register ${provider.providerName} for TEXT_TO_SPEECH: ${formatError(error)}`,
    );
  }
}
