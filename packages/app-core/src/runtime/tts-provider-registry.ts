import process from "node:process";
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import firstPartyRegistry from "@elizaos/registry/first-party/generated.json" with {
  type: "json",
};
import {
  type EdgeTtsHandler,
  wrapEdgeTtsHandlerWithFirstLineCache,
} from "./tts-cache-wiring.js";

export interface TextToSpeechProviderConfig {
  plugins?: {
    entries?: Record<string, { enabled?: boolean } | undefined>;
  };
}

export type TtsModelHandler = (
  runtime: AgentRuntime,
  input: unknown,
) => Promise<unknown>;

export interface TextToSpeechProviderRegistration {
  pluginName: string;
  pluginConfigKey: string;
  providerName: string;
  priority: number;
  loadHandler: () => Promise<TtsModelHandler>;
  wrapHandler?: (handler: TtsModelHandler) => Promise<TtsModelHandler | null>;
}

type TtsPluginModule = {
  default?: { models?: Record<string, TtsModelHandler> };
  edgeTTSPlugin?: { models?: Record<string, TtsModelHandler> };
};

type FirstPartyRegistryEntry = {
  id?: string;
  npmName?: string;
  subtype?: string;
};

function readHandler(
  plugin: TtsPluginModule["default"],
): TtsModelHandler | undefined {
  const handler = plugin?.models?.[ModelType.TEXT_TO_SPEECH];
  return typeof handler === "function" ? handler : undefined;
}

function resolveDefaultTtsPluginName(): string {
  const entries = (
    firstPartyRegistry as { entries?: FirstPartyRegistryEntry[] }
  ).entries;
  const entry = entries?.find(
    (candidate) => candidate.id === "edge-tts" && candidate.subtype === "voice",
  );
  if (!entry?.npmName) {
    throw new Error(
      "First-party registry entry edge-tts did not expose a voice plugin package name",
    );
  }
  return entry.npmName;
}

export const DEFAULT_TEXT_TO_SPEECH_PROVIDER: TextToSpeechProviderRegistration =
  {
    pluginName: resolveDefaultTtsPluginName(),
    pluginConfigKey: "edge-tts",
    providerName: "edge-tts",
    priority: 0,
    async loadHandler(): Promise<TtsModelHandler> {
      const nodeModule = (await import(this.pluginName)) as TtsPluginModule;
      const handler = readHandler(nodeModule.default);
      if (!handler) {
        throw new Error(
          `${DEFAULT_TEXT_TO_SPEECH_PROVIDER.pluginName} did not expose a TEXT_TO_SPEECH handler`,
        );
      }
      return handler;
    },
    wrapHandler: (handler) =>
      wrapEdgeTtsHandlerWithFirstLineCache(handler as EdgeTtsHandler),
  };

export function isTextToSpeechProviderDisabled(
  config: TextToSpeechProviderConfig,
  provider: TextToSpeechProviderRegistration = DEFAULT_TEXT_TO_SPEECH_PROVIDER,
): boolean {
  if (config.plugins?.entries?.[provider.pluginConfigKey]?.enabled === false) {
    return true;
  }

  const raw = process.env ? process.env.ELIZA_DISABLE_EDGE_TTS : undefined;
  if (!raw || typeof raw !== "string") {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
