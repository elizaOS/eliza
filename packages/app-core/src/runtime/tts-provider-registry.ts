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

function findDefaultTtsPluginName(
  entries: FirstPartyRegistryEntry[] | undefined = (
    firstPartyRegistry as { entries?: FirstPartyRegistryEntry[] }
  ).entries,
): string | null {
  const entry = entries?.find(
    (candidate) => candidate.id === "edge-tts" && candidate.subtype === "voice",
  );
  return entry?.npmName ?? null;
}

function createDefaultTextToSpeechProvider(
  pluginName: string,
): TextToSpeechProviderRegistration {
  return {
    pluginName,
    pluginConfigKey: "edge-tts",
    providerName: "edge-tts",
    priority: 0,
    wrapHandler: (handler) =>
      wrapEdgeTtsHandlerWithFirstLineCache(handler as EdgeTtsHandler),
  };
}

export function resolveDefaultTextToSpeechProvider(): TextToSpeechProviderRegistration {
  return resolveDefaultTextToSpeechProviderFromEntries();
}

function resolveDefaultTextToSpeechProviderFromEntries(
  entries?: FirstPartyRegistryEntry[],
): TextToSpeechProviderRegistration {
  const pluginName = findDefaultTtsPluginName(entries);
  if (!pluginName) {
    throw new Error(
      "First-party registry entry edge-tts did not expose a voice plugin package name",
    );
  }
  return createDefaultTextToSpeechProvider(pluginName);
}

export function resolveDefaultTextToSpeechPluginName(): string | null {
  return findDefaultTtsPluginName();
}

export const DEFAULT_TEXT_TO_SPEECH_PROVIDER: TextToSpeechProviderRegistration =
  createDefaultTextToSpeechProvider(findDefaultTtsPluginName() ?? "");

export const __ttsProviderRegistryTestHooks = {
  findDefaultTtsPluginName,
  resolveDefaultTextToSpeechProviderFromEntries,
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
