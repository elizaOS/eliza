/**
 * VoiceTierBanner — device-tier card shown in first-run and at the top of
 * Settings → Voice. Renders the hardware classification (MAX / GOOD / OKAY /
 * POOR); the caller computes and supplies the `tier`.
 */

import { AlertTriangle, BadgeCheck, Gauge, Sparkles } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/utils";

export type VoiceDeviceTier = "MAX" | "GOOD" | "OKAY" | "POOR";

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
  {
    title: string;
    description: string;
    tone: "ok" | "accent" | "warn" | "danger";
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  MAX: {
    title: "Local voice runs at full speed.",
    description: "Recognition, the model, and speech all stay loaded together.",
    tone: "accent",
    icon: Sparkles,
  },
  GOOD: {
    title: "Local voice runs well here.",
    description: "Models load on demand — about half a second to respond.",
    tone: "ok",
    icon: BadgeCheck,
  },
  OKAY: {
    title: "Local voice runs, but slowly.",
    description: "Expect 2-5 seconds before the agent responds.",
    tone: "warn",
    icon: Gauge,
  },
  POOR: {
    title: "Voice routes through Eliza Cloud.",
    description:
      "This device is below the specs for local voice, so it uses the cloud.",
    tone: "danger",
    icon: AlertTriangle,
  },
};

const TONE_TEXT_CLASS = {
  ok: "text-ok",
  accent: "text-accent",
  warn: "text-warn",
  danger: "text-danger",
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
        "flex items-start gap-3 py-1",
        compact && "text-xs",
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-[18px] w-[18px] shrink-0",
          TONE_TEXT_CLASS[copy.tone],
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className="text-sm font-medium text-txt-strong"
            data-testid="voice-tier-title"
          >
            {copy.title}
          </span>
          <span
            className={cn(
              "text-[11px] font-medium uppercase tracking-wide",
              TONE_TEXT_CLASS[copy.tone],
            )}
            data-testid="voice-tier-badge"
          >
            {tier}
          </span>
        </div>
        {!compact ? (
          <p
            className="mt-0.5 text-xs leading-snug text-muted"
            data-testid="voice-tier-description"
          >
            {copy.description}
          </p>
        ) : null}
        {summary ? (
          <p
            className="mt-0.5 text-xs text-muted/80"
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
