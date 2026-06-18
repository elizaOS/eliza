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
    title: "Your device can run everything at once.",
    description:
      "Recognition, the language model, and speech all stay loaded together.",
    tone: "accent",
    icon: Sparkles,
  },
  GOOD: {
    title: "Your device can run the full voice stack.",
    description: "Models load on demand — about half a second to respond.",
    tone: "ok",
    icon: BadgeCheck,
  },
  OKAY: {
    title: "Your device can run voice, but it will be slow.",
    description:
      "Models swap in and out between turns — expect 2-5 seconds before the agent responds.",
    tone: "warn",
    icon: Gauge,
  },
  POOR: {
    title: "Your device is below the recommended specs for local voice.",
    description:
      "Voice routes through Eliza Cloud instead. You can still capture a voice profile for speaker recognition.",
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
        "flex items-start gap-3 rounded-sm border px-3 py-3",
        TONE_CLASS[copy.tone],
        compact && "py-2 text-xs",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm",
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
              "rounded-full px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide",
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
            className="mt-1 text-xs text-muted"
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
