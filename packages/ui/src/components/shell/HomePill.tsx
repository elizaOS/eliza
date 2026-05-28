import * as React from "react";

import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import type { ShellPhase } from "./shell-state";

export interface HomePillProps {
  phase: ShellPhase;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * Persistent home pill at the bottom-center of the viewport. Tapping it
 * toggles the AssistantOverlay; visual state reflects the shell phase.
 *
 * Pure visual + click handler — does not own state. Consumers wire `phase`
 * and the open/close handlers.
 *
 * During the booting phase the button is `disabled` so a click does not
 * silently fire onOpen() against a reducer that would ignore it.
 */
export function HomePill({
  phase,
  onOpen,
  onClose,
}: HomePillProps): React.JSX.Element {
  const isOpen =
    phase === "summoned" || phase === "listening" || phase === "responding";
  const isInteractive = phase !== "booting";

  const handleClick = React.useCallback(() => {
    if (isOpen) onClose();
    else onOpen();
  }, [isOpen, onOpen, onClose]);

  return (
    <button
      type="button"
      disabled={!isInteractive}
      aria-label={isOpen ? "Close Eliza" : "Open Eliza"}
      aria-pressed={isOpen}
      data-phase={phase}
      data-testid="shell-home-pill"
      onClick={handleClick}
      // Use the shell-overlay z-index constant rather than a literal Tailwind
      // class so the value tracks `floating-layers.ts`. Tailwind's JIT only
      // sees literal class strings, so the z-index goes via inline style.
      style={{ zIndex: Z_SHELL_OVERLAY }}
      className={cn(
        // Position: ChatOverlayShell owns fixed bottom-center placement.
        "pointer-events-auto relative mb-3",
        // Shape
        "h-10 w-32 rounded-full",
        // Default (idle) visual
        "relative flex items-center justify-center gap-2 overflow-hidden",
        "bg-card/70 backdrop-blur-md text-txt",
        "border border-border/40",
        // Focus ring
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        // Booting: dim, non-interactive
        phase === "booting" && "opacity-60 cursor-not-allowed",
        // Listening: red pulse + accent ring using the brand orange token
        phase === "listening" &&
          "bg-warn/30 border-warn/60 animate-pulse",
        // Responding: ambient glow on brand orange
        phase === "responding" &&
          "",
        // Summoned: faint glow
        phase === "summoned" && "",
      )}
    >
      <span
        aria-hidden="true"
        data-testid="shell-home-pill-mark"
        className={cn(
          "grid h-6 w-6 place-items-center rounded-full border border-accent/35 bg-accent/15",
          phase === "booting" && "border-muted/30 bg-muted/10",
          phase === "listening" && "border-warn/70 bg-warn/20",
        )}
      >
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full bg-accent ",
            phase === "booting" && "bg-muted shadow-none",
            phase === "listening" &&
              "bg-warn ",
          )}
        />
      </span>
      <span aria-hidden="true" className="flex h-4 items-end gap-0.5">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={cn(
              "block w-1 rounded-full bg-accent/75",
              phase === "booting" && "bg-muted/60",
              phase === "listening" && "bg-warn/90 animate-pulse",
              phase === "responding" && "animate-pulse",
              index === 0 && "h-2",
              index === 1 && "h-3",
              index === 2 && "h-4",
              index === 3 && "h-2.5",
            )}
            style={
              phase === "responding" || phase === "listening"
                ? { animationDelay: `${index * 90}ms` }
                : undefined
            }
          />
        ))}
      </span>
    </button>
  );
}
