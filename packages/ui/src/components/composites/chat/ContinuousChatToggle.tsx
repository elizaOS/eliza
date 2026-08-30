/**
 * ContinuousChatToggle — three-segment switch that lives in the chat header.
 *
 * R10 §2.1 / §2.3. Off / VAD-gated / Always-on.
 *
 * - On wide layouts: three pill buttons inline.
 * - On narrow / mobile layouts: collapses to a single icon button (Mic) that
 *   shows the active mode and opens a sheet on tap; the caller renders the
 *   sheet (we just expose the toggle + a click handler).
 */

import { Mic, Radio, Volume2 } from "lucide-react";
import * as React from "react";

import { cn } from "../../../lib/utils";
import {
  VOICE_CONTINUOUS_MODES,
  type VoiceContinuousMode,
} from "../../../voice/voice-chat-types";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";

export interface ContinuousChatToggleProps {
  value: VoiceContinuousMode;
  onChange: (next: VoiceContinuousMode) => void;
  /** Disable user interaction (e.g. mic permission denied, no STT). */
  disabled?: boolean;
  /** Render the compact (single-icon) variant. */
  compact?: boolean;
  className?: string;
  /** Test/automation hook. */
  "data-testid"?: string;
}

const MODE_META: Record<
  VoiceContinuousMode,
  {
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  off: {
    label: "Off",
    description: "Push-to-talk only. Hold the mic to record.",
    icon: Mic,
  },
  "vad-gated": {
    label: "VAD",
    description:
      "Mic opens automatically when you start speaking and closes on silence.",
    icon: Volume2,
  },
  "always-on": {
    label: "Live",
    description:
      "Mic stays on. The agent decides when you finished speaking and replies.",
    icon: Radio,
  },
};

function isContinuousMode(value: unknown): value is VoiceContinuousMode {
  return (
    typeof value === "string" &&
    (VOICE_CONTINUOUS_MODES as readonly string[]).includes(value)
  );
}

export function ContinuousChatToggle({
  value,
  onChange,
  disabled = false,
  compact = false,
  className,
  "data-testid": dataTestId,
}: ContinuousChatToggleProps): React.ReactElement {
  const handleSelect = React.useCallback(
    (next: VoiceContinuousMode) => {
      if (disabled) return;
      if (!isContinuousMode(next)) return;
      if (next === value) return;
      onChange(next);
    },
    [disabled, onChange, value],
  );

  if (compact) {
    const meta = MODE_META[value];
    const Icon = meta.icon;
    const nextIndex =
      (VOICE_CONTINUOUS_MODES.indexOf(value) + 1) %
      VOICE_CONTINUOUS_MODES.length;
    const nextMode = VOICE_CONTINUOUS_MODES[nextIndex] ?? "off";

    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={value === "off" ? "ghostMuted" : "surfaceAccent"}
              size="icon-sm"
              aria-pressed={value !== "off"}
              aria-label={`Continuous chat: ${meta.label} (tap to switch)`}
              data-testid={dataTestId ?? "continuous-chat-toggle"}
              data-mode={value}
              disabled={disabled}
              onClick={() => handleSelect(nextMode)}
              className={cn("shrink-0", className)}
            >
              <Icon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="text-xs">
              <div className="font-medium">Continuous chat — {meta.label}</div>
              <div className="text-muted">{meta.description}</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Card
      variant="insetCompact"
      flow="row"
      role="radiogroup"
      aria-label="Continuous chat mode"
      data-testid={dataTestId ?? "continuous-chat-toggle"}
      data-mode={value}
      className={cn("inline-flex gap-0.5", className)}
    >
      {VOICE_CONTINUOUS_MODES.map((modeId) => {
        const meta = MODE_META[modeId];
        const Icon = meta.icon;
        const active = modeId === value;
        return (
          <TooltipProvider key={modeId} delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={active ? "surfaceAccent" : "ghostMuted"}
                  size="tiny"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  data-mode={modeId}
                  data-active={active ? "true" : "false"}
                  onClick={() => handleSelect(modeId)}
                >
                  <Icon className="size-3.5" />
                  <span>{meta.label}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="text-xs max-w-[220px]">{meta.description}</div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </Card>
  );
}

export default ContinuousChatToggle;
