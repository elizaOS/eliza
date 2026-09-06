/**
 * Displays hardware suitability for local voice models. The supplied tier does
 * not establish installed models, active routing, or measured response latency.
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
    title: "Strong hardware for local voice.",
    description:
      "This hardware can support larger voice models together. Models still need to be installed and configured.",
    tone: "accent",
    icon: Sparkles,
  },
  GOOD: {
    title: "Hardware suitable for local voice.",
    description:
      "Local voice models can run on this hardware. Install and configure them before using local voice.",
    tone: "ok",
    icon: BadgeCheck,
  },
  OKAY: {
    title: "Limited hardware for local voice.",
    description:
      "Smaller local models may work better. Response time depends on the models and current workload.",
    tone: "warn",
    icon: Gauge,
  },
  POOR: {
    title: "Cloud voice recommended for this hardware.",
    description:
      "This hardware may struggle with local voice models. Connect a Cloud speech provider to use Cloud voice.",
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
            className="mt-0.5 text-xs text-muted"
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
