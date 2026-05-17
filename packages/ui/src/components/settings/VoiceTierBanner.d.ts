/**
 * VoiceTierBanner — device-tier card (R10 §7) used in onboarding step 2 and
 * at the top of the Settings → Voice section.
 *
 * Renders the four-tier hardware classification (MAX / GOOD / OKAY / POOR)
 * with R10 §3.2 copy. R9 owns the actual `tier` value (computed from
 * HardwareProbe); R10 just shows it.
 *
 * Defensive default: when the caller can't compute a tier yet, we render
 * the "GOOD" copy. The onboarding step composes this with a "Continue" /
 * "Use cloud" CTA group depending on the tier.
 */
import type * as React from "react";
export type VoiceDeviceTier = "MAX" | "GOOD" | "OKAY" | "POOR";
export declare const VOICE_DEVICE_TIERS: readonly VoiceDeviceTier[];
export declare const DEFAULT_VOICE_DEVICE_TIER: VoiceDeviceTier;
export interface VoiceTierBannerProps {
  tier: VoiceDeviceTier;
  /** Optional summary line (R9: "16 GB RAM · 8 cores · Apple Silicon"). */
  summary?: string;
  /** Compact layout for the settings card (no CTA group). */
  compact?: boolean;
  className?: string;
  "data-testid"?: string;
}
export declare function VoiceTierBanner({
  tier,
  summary,
  compact,
  className,
  "data-testid": dataTestId,
}: VoiceTierBannerProps): React.ReactElement;
export default VoiceTierBanner;
//# sourceMappingURL=VoiceTierBanner.d.ts.map
