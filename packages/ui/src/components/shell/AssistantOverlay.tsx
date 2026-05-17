import * as React from "react";

import { type ShellPhase } from "./shell-state";

export interface AssistantOverlayProps {
  phase: ShellPhase;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Bottom-sheet / centered-drawer container for the assistant chat.
 *
 * - Renders children only when phase ∈ {summoned, listening, responding}
 * - Listens for Escape on `document` to invoke onClose
 * - Aria: role=dialog + aria-modal=true so screen readers announce it
 *
 * Animation is a single CSS keyframe (defined in base.css as
 * `@keyframes shell-overlay-in`) on enter; respects
 * `prefers-reduced-motion` via Tailwind's `motion-safe:` prefix.
 */
export function AssistantOverlay({
  phase,
  onClose,
  children,
}: AssistantOverlayProps): React.JSX.Element | null {
  const isOpen =
    phase === "summoned" || phase === "listening" || phase === "responding";

  React.useEffect(() => {
    if (!isOpen) return undefined;
    if (typeof document === "undefined") return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Eliza assistant"
      data-testid="shell-assistant-overlay"
      data-phase={phase}
      className={[
        // Position: bottom sheet on mobile, centered drawer on >= sm
        "fixed inset-x-0 bottom-0 z-40",
        "sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto",
        "sm:-translate-x-1/2 sm:-translate-y-1/2",
        "sm:w-[min(560px,90vw)] sm:h-[min(640px,80vh)]",
        // Size on mobile
        "h-[80vh]",
        // Surface
        "rounded-t-3xl sm:rounded-3xl",
        "bg-bg/95 backdrop-blur-xl",
        "border border-border/40",
        "shadow-2xl",
        // Enter motion (skipped under prefers-reduced-motion)
        "motion-safe:animate-[shell-overlay-in_220ms_ease-out]",
      ].join(" ")}
    >
      {children}
    </div>
  );
}
