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
  // GET /api/config replaces stored secrets with this sentinel. It is not a
  // browser credential, but it is durable evidence of an explicit provider.
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

  // Presets select a voice, not a transport. Legacy configs coupled the two by
  // stamping ElevenLabs without a mode or key, guaranteeing a failed first
  // utterance whenever the runtime's usable default was a different provider.
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
    return providerNeutralConfig;
  }

  // Preset state is deterministic character state. Derive it during reads
  // instead of turning normal chat startup into a protected settings write.
  return {
    ...providerNeutralConfig,
    elevenlabs: {
      ...(providerNeutralConfig?.elevenlabs ?? {}),
      voiceId: selectedCharacterVoice.voiceId,
      modelId:
        providerNeutralConfig?.elevenlabs?.modelId ??
        DEFAULT_ELEVENLABS_MODEL_ID,
    },
  };
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
