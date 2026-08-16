/**
 * Renders the compact home pill that anchors launcher access and current shell
 * status.
 */
import * as React from "react";

import { useBranding } from "../../config/branding";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import type { ShellPhase } from "./shell-state";

export interface HomePillProps {
  phase: ShellPhase;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * Persistent Flow-style handle at the bottom-center of the viewport.
 *
 * The visible affordance is deliberately only a short white capsule; the
 * larger transparent button preserves a comfortable pointer target. Status is
 * exposed through ARIA instead of permanent text so the launcher stays out of
 * the user's way until it is invoked.
 */
export function HomePill({
  phase,
  onOpen,
  onClose,
}: HomePillProps): React.JSX.Element {
  const { appName } = useBranding();
  const isOpen =
    phase === "summoned" || phase === "listening" || phase === "responding";

  const handleClick = React.useCallback(() => {
    if (isOpen) onClose();
    else onOpen();
  }, [isOpen, onOpen, onClose]);

  return (
    <Button
      variant="ghost"
      aria-label={isOpen ? `Close ${appName}` : `Open ${appName}`}
      aria-pressed={isOpen}
      data-phase={phase}
      data-testid="shell-home-pill"
      onClick={handleClick}
      style={{ zIndex: Z_SHELL_OVERLAY }}
      className={cn(
        "group pointer-events-auto relative mb-2 flex h-8 w-16 items-center justify-center rounded-full bg-transparent p-0",
        "transition-transform duration-200 hover:bg-transparent active:scale-95",
        "focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
      )}
    >
      <span
        aria-hidden="true"
        data-testid="shell-home-pill-mark"
        className={cn(
          "block h-2.5 w-12 rounded-full bg-white/95",
          "shadow-[0_0_0_1px_rgba(0,0,0,0.12)]",
          "transition-[width,opacity,transform] duration-200 group-hover:w-14",
          phase === "booting" && "animate-pulse opacity-65",
          phase === "listening" && "animate-pulse",
          phase === "responding" && "animate-pulse opacity-85",
        )}
      />
    </Button>
  );
}
