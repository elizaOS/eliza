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
 * Persistent home pill at the bottom-center of the viewport.
 *
 * Thin bar only — no icons, no waveform bars. The bar color shifts with phase.
 * Tapping toggles the AssistantOverlay.
 */
export function HomePill({
  phase,
  onOpen,
  onClose,
}: HomePillProps): React.JSX.Element {
  const { appName } = useBranding();
  const isOpen =
    phase === "summoned" || phase === "listening" || phase === "responding";
  const isInteractive = phase !== "booting";

  const handleClick = React.useCallback(() => {
    if (isOpen) onClose();
    else onOpen();
  }, [isOpen, onOpen, onClose]);

  return (
    <Button
      variant="ghost"
      disabled={!isInteractive}
      aria-label={isOpen ? `Close ${appName}` : `Open ${appName}`}
      aria-pressed={isOpen}
      data-phase={phase}
      data-testid="shell-home-pill"
      onClick={handleClick}
      style={{ zIndex: Z_SHELL_OVERLAY }}
      className={cn(
        "pointer-events-auto relative mb-3",
        // Generous tap target
        "flex h-8 w-32 items-center justify-center",
        phase === "booting" && "cursor-not-allowed opacity-60",
      )}
    >
      {/* The visible thin bar — adapts to phase */}
      <span
        aria-hidden="true"
        data-testid="shell-home-pill-mark"
        className={cn(
          "block h-1.5 w-24 rounded-full transition-all duration-300",
          // Default: theme-adaptive neutral
          "bg-foreground/25",
          phase === "booting" && "bg-foreground/15",
          phase === "listening" && "animate-pulse bg-warn/70",
          phase === "responding" && "bg-accent/70",
          phase === "summoned" && "bg-foreground/40",
        )}
      />
    </Button>
  );
}
