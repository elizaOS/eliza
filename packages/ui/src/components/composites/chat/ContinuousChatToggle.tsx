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
              variant="ghost"
              size="icon"
              aria-pressed={value !== "off"}
              aria-label={`Continuous chat: ${meta.label} (tap to switch)`}
              data-testid={dataTestId ?? "continuous-chat-toggle"}
              data-mode={value}
              disabled={disabled}
              onClick={() => handleSelect(nextMode)}
              className={cn(
                "h-8 w-8 shrink-0",
                value === "always-on" && "text-accent",
                value === "vad-gated" && "text-ok",
                value === "off" && "text-muted",
                className,
              )}
            >
              <Icon className="h-4 w-4" />
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
    <div
      role="radiogroup"
      aria-label="Continuous chat mode"
      data-testid={dataTestId ?? "continuous-chat-toggle"}
      data-mode={value}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border/40 bg-card/30 p-0.5",
        disabled && "opacity-50 pointer-events-none",
        className,
      )}
    >
      {VOICE_CONTINUOUS_MODES.map((modeId) => {
        const meta = MODE_META[modeId];
        const Icon = meta.icon;
        const active = modeId === value;
        return (
          <TooltipProvider key={modeId} delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* biome-ignore lint/a11y/useSemanticElements: themed button retains all custom styles and tooltip integration; a native input[type=radio] would lose them. */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-mode={modeId}
                  data-active={active ? "true" : "false"}
                  onClick={() => handleSelect(modeId)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg",
                    active
                      ? "bg-accent/15 text-accent-fg dark:text-accent shadow-sm"
                      : "text-muted hover:text-txt hover:bg-bg-hover",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{meta.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="text-xs max-w-[220px]">{meta.description}</div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </div>
  );
}

export default ContinuousChatToggle;
