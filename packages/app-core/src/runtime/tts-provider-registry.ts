/**
 * Resolves the default text-to-speech provider from the first-party plugin
 * registry. The default is data-driven: the owning voice plugin marks its
 * registry entry `defaultTextToSpeech: true` (guarded by `subtype: "voice"`),
 * and its `id`/`npmName` flow through as the provider name, config key, and
 * disable-flag lookup — no plugin id is hard-coded in the resolution path.
 * Entries are metadata-only (the concrete handler self-registers at plugin
 * load); this module also exposes the config/env disable check for the resolved
 * provider.
 */
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
  defaultTextToSpeech?: boolean;
};

// The default TTS provider is chosen by data, not by a hard-coded plugin id:
// the owning voice plugin marks its registry entry `defaultTextToSpeech: true`
// (see packages/registry schema + plugin-edge-tts/registry-entry.json). Swapping
// the default is a registry edit, not a code change here. The `subtype: "voice"`
// check is an invariant guard — the flag is only meaningful on a voice plugin.
function findDefaultTtsEntry(
  entries: FirstPartyRegistryEntry[] | undefined = (
    firstPartyRegistry as { entries?: FirstPartyRegistryEntry[] }
  ).entries,
): FirstPartyRegistryEntry | null {
  return (
    entries?.find(
      (candidate) =>
        candidate.defaultTextToSpeech === true && candidate.subtype === "voice",
    ) ?? null
  );
}

// Config key + provider name flow from the resolved entry's own `id`, so a
// registry that flags a different voice entry as default carries that entry's id
// through to the disable-flag lookup and model registration — no id literal in
// this resolution path.
function createDefaultTextToSpeechProvider(
  entry: FirstPartyRegistryEntry,
): TextToSpeechProviderRegistration {
  const providerName = entry.id ?? "";
  return {
    pluginName: entry.npmName ?? "",
    pluginConfigKey: providerName,
    providerName,
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
  const entry = findDefaultTtsEntry(entries);
  if (!entry?.npmName) {
    throw new Error(
      "First-party registry has no default voice plugin (defaultTextToSpeech + npmName)",
    );
  }
  return createDefaultTextToSpeechProvider(entry);
}

export function resolveDefaultTextToSpeechPluginName(): string | null {
  return findDefaultTtsEntry()?.npmName ?? null;
}

export const DEFAULT_TEXT_TO_SPEECH_PROVIDER: TextToSpeechProviderRegistration =
  createDefaultTextToSpeechProvider(findDefaultTtsEntry() ?? {});

export const __ttsProviderRegistryTestHooks = {
  findDefaultTtsEntry,
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
