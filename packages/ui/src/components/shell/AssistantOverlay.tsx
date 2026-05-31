import { X } from "lucide-react";
import * as React from "react";

import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import type { ShellPhase } from "./shell-state";

export interface AssistantOverlayProps {
  phase: ShellPhase;
  onClose: () => void;
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom-sheet / centered-drawer container for the assistant chat.
 *
 * - Renders children only when phase ∈ {summoned, listening, responding}
 * - Listens for Escape on `document` to invoke onClose
 * - Aria: role=dialog + aria-modal=true so screen readers announce it
 * - Focus management (WAI-ARIA Dialog pattern):
 *   - On open: remembers the previously focused element and moves focus
 *     into the dialog (first focusable descendant, or the dialog itself).
 *   - While open: Tab and Shift+Tab cycle within the dialog only.
 *   - On close: restores focus to the previously focused element.
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
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  // Manage Escape, focus trap, initial focus, and focus return as a single
  // effect bound to isOpen so cleanup/setup pair correctly across opens.
  React.useEffect(() => {
    if (!isOpen) return undefined;
    if (typeof document === "undefined") return undefined;

    // Remember where focus was before we steal it.
    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    // Move initial focus into the dialog after mount. The dialog itself has
    // tabIndex={-1} so it can receive programmatic focus if no descendant is
    // focusable yet (e.g., empty ChatSurface with disabled send).
    const dialog = dialogRef.current;
    if (dialog) {
      const firstFocusable =
        dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable ?? dialog).focus();
    }

    function getFocusable(): HTMLElement[] {
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || active === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to the trigger (e.g. the HomePill).
      const previous = previousFocusRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus();
      }
      previousFocusRef.current = null;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Eliza assistant"
      data-testid="shell-assistant-overlay"
      data-phase={phase}
      // Sits one tick above the pill so the drawer covers it on open.
      // Inline style because Tailwind's JIT can't track template-interpolated
      // arbitrary z-index values. See packages/ui/src/lib/floating-layers.ts.
      style={{ zIndex: Z_SHELL_OVERLAY + 1 }}
      className={[
        "shell-assistant-overlay-panel pointer-events-auto",
        // Position: bottom sheet on mobile, centered drawer on >= sm
        "fixed inset-x-0 bottom-0",
        "sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto",
        "sm:-translate-x-1/2 sm:-translate-y-1/2",
        "sm:w-[min(560px,90vw)] sm:h-[min(640px,80vh)]",
        // Size on mobile
        "h-[80vh]",
        // Surface
        "rounded-t-3xl sm:rounded-sm",
        "bg-bg/95 backdrop-blur-xl",
        "border border-border/40",
        "",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        // Enter motion (skipped under prefers-reduced-motion)
        "motion-safe:animate-[shell-overlay-in_220ms_ease-out]",
      ].join(" ")}
    >
      <button
        type="button"
        aria-label="Close assistant"
        onClick={onClose}
        className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-card/60 text-muted transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}
