import { ModelType } from "@elizaos/core";
import type { TtsModelHandler } from "./tts-provider-registry.js";

/**
 * Guarded, centralized loader for the default (edge-tts) TTS package.
 *
 * The primary path is that the edge-tts plugin self-registers its
 * `ModelType.TEXT_TO_SPEECH` handler on the runtime when it loads (it is a
 * normal plugin with an `autoEnable` gate and a `models` map). This loader is
 * only used as the fallback for boot paths where that plugin was not collected,
 * so streaming / swarm voice can still resolve a handler.
 *
 * Unlike the previous registry-driven `import(pluginName)`, the specifier here
 * is a **string literal**, so bundlers can resolve it (or deliberately stub it)
 * and it fails at build time rather than silently at runtime. It stays a
 * *dynamic* import so the optional package is not eagerly pulled into bundles
 * that never synthesize speech.
 */
type EdgeTtsPluginModule = {
  default?: { models?: Record<string, TtsModelHandler> };
  edgeTTSPlugin?: { models?: Record<string, TtsModelHandler> };
};

function readTextToSpeechHandler(
  mod: EdgeTtsPluginModule,
): TtsModelHandler | undefined {
  const handler =
    mod.default?.models?.[ModelType.TEXT_TO_SPEECH] ??
    mod.edgeTTSPlugin?.models?.[ModelType.TEXT_TO_SPEECH];
  return typeof handler === "function" ? handler : undefined;
}

export async function loadDefaultTextToSpeechHandler(): Promise<TtsModelHandler> {
  const mod = (await import("@elizaos/plugin-edge-tts")) as EdgeTtsPluginModule;
  const handler = readTextToSpeechHandler(mod);
  if (!handler) {
    throw new Error(
      "@elizaos/plugin-edge-tts did not expose a TEXT_TO_SPEECH handler",
    );
  }
  return handler;
}
