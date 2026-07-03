import { loadElizaConfig } from "@elizaos/agent";
import { type AgentRuntime, logger, ModelType } from "@elizaos/core";
import { formatError } from "@elizaos/shared";
import { loadDefaultTextToSpeechHandler } from "./tts-default-handler.js";
import {
  DEFAULT_TEXT_TO_SPEECH_PROVIDER,
  isTextToSpeechProviderDisabled,
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

/**
 * `@elizaos/agent` boot calls its own `collectPluginNames`, so the app wrapper
 * that adds the default TTS provider is bypassed. Register the model handler on
 * the live runtime so streaming / swarm voice can still resolve TEXT_TO_SPEECH.
 */
export async function ensureTextToSpeechHandler(
  runtime: AgentRuntime,
): Promise<void> {
  const config = loadElizaConfig();
  const provider = DEFAULT_TEXT_TO_SPEECH_PROVIDER;
  if (isTextToSpeechProviderDisabled(config, provider)) {
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
