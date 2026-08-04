/**
 * Resolves a character's voice config: applies provider defaults, maps style
 * presets to voices, and normalizes the persisted VoiceConfig shape.
 */
import {
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
} from "@elizaos/shared";
import type { VoiceConfig } from "../api/client";
import { asRecord } from "../state/config-readers";
import { hasConfiguredApiKey, PREMADE_VOICES } from "./types";
import type { DefaultVoiceProviderResult } from "./voice-provider-defaults";

const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

const LEGACY_CHARACTER_VOICE_PRESET_IDS: Record<string, string> = {
  jin: "adam",
  kei: "josh",
  momo: "alice",
  rin: "matilda",
  ryu: "daniel",
  satoshi: "brian",
  yuki: "lily",
};

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveStoredVoiceConfig(
  config: Record<string, unknown>,
): VoiceConfig | null {
  const messages = asRecord(config.messages);
  const tts = asRecord(messages?.tts);
  return tts ? (tts as VoiceConfig) : null;
}

function resolveSelectedCharacterVoiceId(
  config: Record<string, unknown>,
  uiLanguage: string,
): { characterId: string; voiceId: string } | null {
  const ui = asRecord(config.ui);
  const presetId = readString(ui, "presetId");
  const preset =
    resolveStylePresetById(presetId, uiLanguage) ??
    resolveStylePresetByAvatarIndex(readNumber(ui, "avatarIndex"), uiLanguage);
  if (!preset?.id || !preset.voicePresetId) {
    return null;
  }
  const voice = PREMADE_VOICES.find(
    (entry) => entry.id === preset.voicePresetId,
  );
  if (!voice) {
    return null;
  }
  return { characterId: preset.id, voiceId: voice.voiceId };
}

function resolveLegacyVoiceId(characterId: string): string | null {
  const legacyPresetId = LEGACY_CHARACTER_VOICE_PRESET_IDS[characterId];
  if (!legacyPresetId) {
    return null;
  }
  const voice = PREMADE_VOICES.find((entry) => entry.id === legacyPresetId);
  return voice?.voiceId ?? null;
}

function isExplicitElevenLabsChoice(config: VoiceConfig | null): boolean {
  const apiKey = config?.elevenlabs?.apiKey?.trim() ?? "";
  // GET /api/config replaces a stored secret with this sentinel. It is not a
  // usable browser key, but it is durable evidence that the user configured
  // ElevenLabs; treating it as absent would rewrite their provider on load.
  const hasStoredKeyEvidence =
    apiKey.toUpperCase() === "[REDACTED]" ||
    apiKey.toUpperCase() === "REDACTED";
  return Boolean(
    config?.provider === "elevenlabs" &&
      (config.mode === "cloud" ||
        config.mode === "own-key" ||
        hasConfiguredApiKey(apiKey) ||
        hasStoredKeyEvidence),
  );
}

function withoutVoiceProvider(config: VoiceConfig): VoiceConfig {
  const providerNeutralConfig = { ...config };
  delete providerNeutralConfig.provider;
  return providerNeutralConfig;
}

export function resolveCharacterVoiceConfigFromAppConfig(args: {
  config: Record<string, unknown>;
  uiLanguage: string;
}): VoiceConfig | null {
  const storedVoiceConfig = resolveStoredVoiceConfig(args.config);
  const selectedCharacterVoice = resolveSelectedCharacterVoiceId(
    args.config,
    args.uiLanguage,
  );
  if (!selectedCharacterVoice) {
    return storedVoiceConfig;
  }

  if (
    storedVoiceConfig?.provider &&
    storedVoiceConfig.provider !== "elevenlabs"
  ) {
    return storedVoiceConfig;
  }

  // Character presets select a voice, not a transport. Old configs coupled the
  // two by stamping `provider: elevenlabs` without a mode or usable key, which
  // bypasses capability defaults and guarantees a fail-closed first utterance.
  // A mode or usable key is an explicit modern ElevenLabs choice and remains
  // authoritative; otherwise remove only the legacy provider pin.
  const releaseLegacyProvider =
    storedVoiceConfig?.provider === "elevenlabs" &&
    !isExplicitElevenLabsChoice(storedVoiceConfig);
  const providerNeutralConfig = releaseLegacyProvider
    ? withoutVoiceProvider(storedVoiceConfig)
    : storedVoiceConfig;

  const currentVoiceId =
    typeof storedVoiceConfig?.elevenlabs?.voiceId === "string"
      ? storedVoiceConfig.elevenlabs.voiceId.trim()
      : "";
  const legacyVoiceId = resolveLegacyVoiceId(
    selectedCharacterVoice.characterId,
  );
  const shouldUpdatePresetVoice =
    selectedCharacterVoice.voiceId !== currentVoiceId &&
    (!currentVoiceId ||
      currentVoiceId === DEFAULT_ELEVENLABS_VOICE_ID ||
      currentVoiceId === legacyVoiceId);

  if (!releaseLegacyProvider && !shouldUpdatePresetVoice) {
    return storedVoiceConfig;
  }

  if (!shouldUpdatePresetVoice) {
    // Provider-neutralizing an old preset is a read-time compatibility rule,
    // not an implicit settings mutation. This also keeps signed-out clients
    // from retrying a protected config write every time voice state reloads.
    return providerNeutralConfig;
  }

  const voiceConfig: VoiceConfig = {
    ...providerNeutralConfig,
    elevenlabs: {
      ...(providerNeutralConfig?.elevenlabs ?? {}),
      voiceId: selectedCharacterVoice.voiceId,
      modelId:
        providerNeutralConfig?.elevenlabs?.modelId ??
        DEFAULT_ELEVENLABS_MODEL_ID,
    },
  };

  // The preset voice is deterministic character state. Keeping it derived
  // avoids a protected settings write during ordinary chat startup; explicit
  // choices made in Voice Settings still persist through that surface.
  return voiceConfig;
}

/**
 * Seed the platform/runtime provider defaults onto a loaded voice config,
 * leaving any explicit user choice untouched.
 *
 * `resolvedTtsProvider` is the capability-aware default from
 * `resolveDefaultTtsProvider` (on-device Kokoro when staged, else Eliza Cloud
 * Kokoro, else ElevenLabs, else browser SpeechSynthesis). When omitted the
 * platform/mode preference in `defaults.tts` is used directly — the pre-probe
 * fallback, still a Kokoro transport on every device. The ASR default always
 * comes from the platform matrix; the interactive-capture engine is chosen
 * independently in `voice-capture-factory.ts`.
 */
export function applyVoiceProviderDefaults(
  config: VoiceConfig | null,
  defaults: DefaultVoiceProviderResult,
  resolvedTtsProvider?: VoiceConfig["provider"],
): VoiceConfig {
  const base = config ?? {};
  return {
    ...base,
    provider: base.provider ?? resolvedTtsProvider ?? defaults.tts,
    asr: base.asr ?? { provider: defaults.asr },
  };
}
