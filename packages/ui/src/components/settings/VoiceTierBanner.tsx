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

// biome-ignore lint/correctness/noUnusedImports: Required for JSX transform.
import * as React from "react";
import { AlertTriangle, BadgeCheck, Gauge, Sparkles } from "lucide-react";

import { cn } from "../../lib/utils";

export type VoiceDeviceTier = "MAX" | "GOOD" | "OKAY" | "POOR";

export const VOICE_DEVICE_TIERS: readonly VoiceDeviceTier[] = [
  "MAX",
  "GOOD",
  "OKAY",
  "POOR",
] as const;

export const DEFAULT_VOICE_DEVICE_TIER: VoiceDeviceTier = "GOOD";

export interface VoiceTierBannerProps {
  tier: VoiceDeviceTier;
  /** Optional summary line (R9: "16 GB RAM · 8 cores · Apple Silicon"). */
  summary?: string;
  /** Compact layout for the settings card (no CTA group). */
  compact?: boolean;
  className?: string;
  "data-testid"?: string;
}

const TIER_COPY: Record<
  VoiceDeviceTier,
  { title: string; description: string; tone: "ok" | "accent" | "warn" | "danger"; icon: React.ComponentType<{ className?: string }> }
> = {
  MAX: {
    title: "Your device can run everything at once.",
    description:
      "Voice recognition, the language model, and natural speech can all stay loaded together. Conversations will feel instant.",
    tone: "accent",
    icon: Sparkles,
  },
  GOOD: {
    title: "Your device can run the full voice stack.",
    description:
      "Models will load on demand. Expect roughly half a second between when you stop talking and when the agent starts responding.",
    tone: "ok",
    icon: BadgeCheck,
  },
  OKAY: {
    title: "Your device can run voice, but it will be slow.",
    description:
      "Models will swap in and out of memory between turns. Expect 2-5 seconds of silence before the agent responds. Plugging in helps.",
    tone: "warn",
    icon: Gauge,
  },
  POOR: {
    title: "Your device is below the recommended specs for local voice.",
    description:
      "We'll route voice through Eliza Cloud instead so you don't wait minutes per turn. You can still capture your voice profile for speaker recognition.",
    tone: "danger",
    icon: AlertTriangle,
  },
};

const TONE_CLASS = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  accent: "border-accent/40 bg-accent/10 text-accent",
  warn: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-danger/40 bg-danger/10 text-danger",
} as const;

const TONE_BADGE_CLASS = {
  ok: "bg-ok/20 text-ok",
  accent: "bg-accent/20 text-accent",
  warn: "bg-warn/20 text-warn",
  danger: "bg-danger/20 text-danger",
} as const;

export function VoiceTierBanner({
  tier,
  summary,
  compact = false,
  className,
  "data-testid": dataTestId,
}: VoiceTierBannerProps): React.ReactElement {
  const copy = TIER_COPY[tier];
  const Icon = copy.icon;

  return (
    <div
      data-testid={dataTestId ?? "voice-tier-banner"}
      data-tier={tier}
      data-tone={copy.tone}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-3",
        TONE_CLASS[copy.tone],
        compact && "py-2 text-xs",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          TONE_BADGE_CLASS[copy.tone],
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              TONE_BADGE_CLASS[copy.tone],
            )}
            data-testid="voice-tier-badge"
          >
            {tier}
          </span>
          <span
            className="text-sm font-semibold text-txt"
            data-testid="voice-tier-title"
          >
            {copy.title}
          </span>
        </div>
        <p
          className="mt-1 text-xs leading-snug text-txt/85"
          data-testid="voice-tier-description"
        >
          {copy.description}
        </p>
        {summary ? (
          <p
            className="mt-1 text-[11px] text-muted"
            data-testid="voice-tier-summary"
          >
            {summary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default VoiceTierBanner;
