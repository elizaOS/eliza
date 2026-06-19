import type { VoiceDeviceTier } from "./VoiceTierBanner";

export const VOICE_DEVICE_TIERS: readonly VoiceDeviceTier[] = [
  "MAX",
  "GOOD",
  "OKAY",
  "POOR",
] as const;

export const DEFAULT_VOICE_DEVICE_TIER: VoiceDeviceTier = "GOOD";
