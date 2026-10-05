/**
 * The ordered voice device-tier list and the default tier, used by
 * VoiceTierBanner and its tier-selection UI.
 */

import type { VoiceDeviceTier } from "./VoiceTierBanner";

export const VOICE_DEVICE_TIERS: readonly VoiceDeviceTier[] = [
  "MAX",
  "GOOD",
  "OKAY",
  "POOR",
] as const;
