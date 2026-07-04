/**
 * Re-exports the shared voice types (presets, provider list, premade voices, key
 * sanitizers) so the UI voice surface has one canonical source.
 */
export type { VoicePreset } from "@elizaos/shared";
export {
  EDGE_BACKUP_VOICES,
  hasConfiguredApiKey,
  PREMADE_VOICES,
  sanitizeApiKey,
  VOICE_PROVIDERS,
} from "@elizaos/shared";
