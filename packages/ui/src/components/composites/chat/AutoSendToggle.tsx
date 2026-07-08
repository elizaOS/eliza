/**
 * AutoSendToggle — in-flow mic-surface switch for hands-free voice auto-send
 * (voice auto-send lane, on top of V2a #15417).
 *
 * Placement: rendered INSIDE the chat composer, immediately adjacent to the mic
 * button, so the user flips auto-send exactly where they speak — never buried in
 * a settings page. Deliberately mirrors {@link ContinuousChatToggle}'s compact
 * variant (single lucide icon button, token palette, tooltip) so it reads as the
 * same family of voice controls.
 *
 * States:
 * - OFF (default): `PenLine` icon, muted — finalized voice transcript fills the
 *   composer draft for the user to review + send ("review" launch default).
 * - ON: `Send` icon, accent — a finalized transcript that clears the min-
 *   transcript reliability guard is sent immediately, hands-free.
 *
 * Pure presentational + a click handler; the caller owns the persisted value.
 */

import { PenLine, Send } from "lucide-react";
import * as React from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";

export interface AutoSendToggleProps {
  /** True when hands-free auto-send is enabled. */
  value: boolean;
  /** Called with the next value when the user toggles. */
  onChange: (next: boolean) => void;
  /** Disable interaction (e.g. composer locked / no STT). */
  disabled?: boolean;
  className?: string;
  /** Test/automation hook. */
  "data-testid"?: string;
}

export function AutoSendToggle({
  value,
  onChange,
  disabled = false,
  className,
  "data-testid": dataTestId,
}: AutoSendToggleProps): React.ReactElement {
  const Icon = value ? Send : PenLine;
  const label = value
    ? "Auto-send on — voice sends automatically (tap to review first)"
    : "Auto-send off — voice fills the draft to review (tap to auto-send)";
  const handleClick = React.useCallback(() => {
    if (disabled) return;
    onChange(!value);
  }, [disabled, onChange, value]);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={value}
            aria-label={label}
            data-testid={dataTestId ?? "chat-composer-auto-send-toggle"}
            data-auto-send={value ? "on" : "off"}
            disabled={disabled}
            onClick={handleClick}
            className={cn(
              "h-8 w-8 shrink-0 rounded-sm p-0 shadow-none transition-colors active:scale-95 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
              value ? "text-accent hover:text-accent" : "text-muted hover:text-txt",
              className,
            )}
          >
            <Icon className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="text-xs">
            <div className="font-medium">
              Voice auto-send {value ? "on" : "off"}
            </div>
            <div className="text-muted max-w-[220px]">
              {value
                ? "A finished voice message is sent automatically."
                : "A finished voice message fills the draft to review first."}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default AutoSendToggle;
