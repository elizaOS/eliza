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
        // Position
        "fixed bottom-3 left-1/2 -translate-x-1/2",
        // Shape
        "h-10 w-32 rounded-full",
        // Default (idle) visual
        "bg-card/70 backdrop-blur-md text-txt",
        "border border-border/40",
        // Focus ring
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        // Booting: dim, non-interactive
        phase === "booting" && "opacity-60 cursor-not-allowed",
        // Listening: red pulse + accent ring using the brand orange token
        phase === "listening" &&
          "bg-warn/30 border-warn/60 shadow-[0_0_24px_rgba(var(--accent-rgb),0.55)] animate-pulse",
        // Responding: ambient glow on brand orange
        phase === "responding" &&
          "shadow-[0_0_18px_rgba(var(--accent-rgb),0.35)]",
        // Summoned: faint glow
        phase === "summoned" && "shadow-[0_0_10px_rgba(255,255,255,0.15)]",
      )}
    />
  );
}
