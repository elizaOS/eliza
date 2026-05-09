import {
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
} from "@elizaos/shared";
import type { VoiceConfig } from "../api/client";
import { asRecord } from "../state/config-readers";
import { PREMADE_VOICES } from "./types";

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

export function resolveCharacterVoiceConfigFromAppConfig(args: {
  config: Record<string, unknown>;
  uiLanguage: string;
}): { voiceConfig: VoiceConfig | null; shouldPersist: boolean } {
  const storedVoiceConfig = resolveStoredVoiceConfig(args.config);
  const selectedCharacterVoice = resolveSelectedCharacterVoiceId(
    args.config,
    args.uiLanguage,
  );
  if (!selectedCharacterVoice) {
    return { voiceConfig: storedVoiceConfig, shouldPersist: false };
  }

  if (
    storedVoiceConfig?.provider &&
    storedVoiceConfig.provider !== "elevenlabs"
  ) {
    return { voiceConfig: storedVoiceConfig, shouldPersist: false };
  }

  const currentVoiceId =
    typeof storedVoiceConfig?.elevenlabs?.voiceId === "string"
      ? storedVoiceConfig.elevenlabs.voiceId.trim()
      : "";
  const legacyVoiceId = resolveLegacyVoiceId(
    selectedCharacterVoice.characterId,
  );
  const shouldPersist =
    selectedCharacterVoice.voiceId !== currentVoiceId &&
    (!currentVoiceId ||
      currentVoiceId === DEFAULT_ELEVENLABS_VOICE_ID ||
      currentVoiceId === legacyVoiceId);

  if (!shouldPersist) {
    return { voiceConfig: storedVoiceConfig, shouldPersist: false };
  }

  return {
    voiceConfig: {
      ...storedVoiceConfig,
      provider: "elevenlabs",
      elevenlabs: {
        ...(storedVoiceConfig?.elevenlabs ?? {}),
        voiceId: selectedCharacterVoice.voiceId,
        modelId:
          storedVoiceConfig?.elevenlabs?.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID,
      },
    },
    shouldPersist: true,
  };
}
