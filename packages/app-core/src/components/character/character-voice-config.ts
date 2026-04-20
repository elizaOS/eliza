/**
 * Voice-related constants and helpers extracted from CharacterEditor.
 */

import type { VoiceConfig } from "../../api/client";
import {
  EDGE_BACKUP_VOICES,
  hasConfiguredApiKey,
  PREMADE_VOICES,
} from "../../voice/types";
import type { CharacterRosterEntry } from "./CharacterRoster";

/* ── Constants ─────────────────────────────────────────────────────── */

export const DEFAULT_ELEVEN_FAST_MODEL = "eleven_flash_v2_5";

export const ELEVENLABS_VOICE_GROUPS = [
  {
    labelKey: "charactereditor.VoiceGroupFemale",
    defaultLabel: "Female",
    items: PREMADE_VOICES.filter((p) => p.gender === "female").map((p) => ({
      id: p.id,
      text: p.name,
    })),
  },
  {
    labelKey: "charactereditor.VoiceGroupMale",
    defaultLabel: "Male",
    items: PREMADE_VOICES.filter((p) => p.gender === "male").map((p) => ({
      id: p.id,
      text: p.name,
    })),
  },
  {
    labelKey: "charactereditor.VoiceGroupCharacter",
    defaultLabel: "Character",
    items: PREMADE_VOICES.filter((p) => p.gender === "character").map((p) => ({
      id: p.id,
      text: p.name,
    })),
  },
];

export const EDGE_VOICE_GROUPS = [
  {
    labelKey: "charactereditor.BackupVoices",
    defaultLabel: "Backup Voices",
    items: EDGE_BACKUP_VOICES.map((p) => ({
      id: p.id,
      text: p.name,
    })),
  },
];

/* ── Types ─────────────────────────────────────────────────────────── */

export type CharacterEditorVoiceConfig = VoiceConfig;

/* ── Helpers ───────────────────────────────────────────────────────── */

export function buildVoiceConfigForCharacterEntry(args: {
  entry: CharacterRosterEntry;
  useElevenLabs: boolean;
  voiceConfig: CharacterEditorVoiceConfig;
}): {
  nextVoiceConfig: CharacterEditorVoiceConfig;
  persistedVoiceConfig: CharacterEditorVoiceConfig;
  selectedVoicePresetId: string;
} | null {
  const presetVoice = args.entry.voicePresetId
    ? PREMADE_VOICES.find((preset) => preset.id === args.entry.voicePresetId)
    : undefined;
  if (!presetVoice) {
    return null;
  }

  if (args.useElevenLabs) {
    const existingElevenlabs =
      typeof args.voiceConfig.elevenlabs === "object"
        ? args.voiceConfig.elevenlabs
        : {};
    const defaultVoiceMode =
      typeof args.voiceConfig.mode === "string"
        ? args.voiceConfig.mode
        : hasConfiguredApiKey(existingElevenlabs.apiKey)
          ? "own-key"
          : "cloud";
    const nextVoiceConfig: CharacterEditorVoiceConfig = {
      ...args.voiceConfig,
      provider: "elevenlabs",
      mode: defaultVoiceMode,
      elevenlabs: {
        ...existingElevenlabs,
        voiceId: presetVoice.voiceId,
        modelId: existingElevenlabs.modelId ?? DEFAULT_ELEVEN_FAST_MODEL,
      },
    };
    return {
      nextVoiceConfig,
      persistedVoiceConfig: nextVoiceConfig,
      selectedVoicePresetId: presetVoice.id,
    };
  }

  const edgeGender =
    presetVoice.gender === "male" ? "edge-male" : "edge-female";
  const edgeVoice = EDGE_BACKUP_VOICES.find((voice) => voice.id === edgeGender);
  if (!edgeVoice) {
    return null;
  }
  const existingEdge =
    typeof args.voiceConfig.edge === "object" ? args.voiceConfig.edge : {};
  const nextVoiceConfig: CharacterEditorVoiceConfig = {
    ...args.voiceConfig,
    provider: "edge",
    edge: {
      ...existingEdge,
      voice: edgeVoice.voiceId,
    },
  };
  return {
    nextVoiceConfig,
    persistedVoiceConfig: nextVoiceConfig,
    selectedVoicePresetId: edgeVoice.id,
  };
}
