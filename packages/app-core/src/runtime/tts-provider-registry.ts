import process from "node:process";
import type { AgentRuntime } from "@elizaos/core";
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

/**
 * Metadata-only description of a TTS provider. The concrete handler is NOT
 * referenced here — voice plugins self-register their `TEXT_TO_SPEECH` handler
 * on the runtime at plugin load (via their `models` map / `registerModel`), and
 * the fallback loader for the default provider lives in `tts-default-handler.ts`
 * behind a bundler-resolvable literal import. This entry carries no importable
 * module path, so it stays browser-safe and bundler-analyzable.
 */
export interface TextToSpeechProviderRegistration {
  pluginName: string;
  pluginConfigKey: string;
  providerName: string;
  priority: number;
  wrapHandler?: (handler: TtsModelHandler) => Promise<TtsModelHandler | null>;
}

type FirstPartyRegistryEntry = {
  id?: string;
  npmName?: string;
  subtype?: string;
};

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
