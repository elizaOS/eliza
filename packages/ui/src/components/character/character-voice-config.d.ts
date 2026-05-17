/**
 * Voice-related constants and helpers extracted from CharacterEditor.
 */
import type { VoiceConfig } from "../../api/client";
import type { CharacterRosterEntry } from "./CharacterRoster";
export declare const DEFAULT_ELEVEN_FAST_MODEL = "eleven_flash_v2_5";
export declare const ELEVENLABS_VOICE_GROUPS: {
  labelKey: string;
  defaultLabel: string;
  items: {
    id: string;
    text: string;
  }[];
}[];
export declare const EDGE_VOICE_GROUPS: {
  labelKey: string;
  defaultLabel: string;
  items: {
    id: string;
    text: string;
  }[];
}[];
export type CharacterEditorVoiceConfig = VoiceConfig;
export declare function buildVoiceConfigForCharacterEntry(args: {
  entry: CharacterRosterEntry;
  useElevenLabs: boolean;
  voiceConfig: CharacterEditorVoiceConfig;
}): {
  nextVoiceConfig: CharacterEditorVoiceConfig;
  persistedVoiceConfig: CharacterEditorVoiceConfig;
  selectedVoicePresetId: string;
} | null;
//# sourceMappingURL=character-voice-config.d.ts.map
