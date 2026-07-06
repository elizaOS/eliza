/**
 * The pull-up notification shade: an Apple-style sheet that keeps the inbox
 * hidden until the user pulls it up from the home. HomeScreen renders a small
 * bottom hint pill (unread-count aware, self-hides when the inbox is empty);
 * pulling up on it — or tapping it — opens this sheet over a tinted scrim.
 * The shade renders the shared {@link NotificationsHomeCenter} card, so open /
 * dismiss / mark-all-read / clear all flow through the one notification store,
 * and rows arrive grouped by view, priority-then-newest.
 *
 * Portal-mounted at the shell-overlay z-layer and only while open, so the home
 * pays zero DOM cost at rest and opening never reflows the dashboard — the
 * sheet floats over it (the continuous chat overlay lives above both).
 * Scrim tap, grabber tap, and Escape dismiss.
 */

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { NotificationsHomeCenter } from "./NotificationsHomeCenter";

// Slide-up + scrim fade, local to the shade; transform/opacity only and fully
// stilled under prefers-reduced-motion (the house bottom-sheet pattern).
const SHADE_CSS = `
@keyframes notif-shade-in {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: none; }
}
@keyframes notif-shade-scrim-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.notif-shade-sheet { animation: notif-shade-in 280ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.notif-shade-scrim { animation: notif-shade-scrim-in 200ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .notif-shade-sheet, .notif-shade-scrim { animation: none; }
}
`;

export interface NotificationsShadeProps {
  /** Dismiss the shade (scrim tap, grabber, or Escape). */
  onClose: () => void;
}

/** The pull-up sheet wrapping the notification inbox. Mounted only while open. */
export function NotificationsShade({
  onClose,
}: NotificationsShadeProps): React.JSX.Element | null {
  const labelId = useId();
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    // Move focus into the sheet after the enter animation commits so a
    // keyboard user lands on the inbox, not the home behind the scrim.
    const id = window.requestAnimationFrame(() => {
      sheetRef.current?.focus();
    });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(id);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      data-testid="notifications-shade"
      className="fixed inset-0 flex items-end justify-center"
      style={{ zIndex: Z_SHELL_OVERLAY + 4 }}
    >
      <style>{SHADE_CSS}</style>
      <button
        type="button"
        aria-label="Close notifications"
        data-testid="notifications-shade-scrim"
        onClick={onClose}
        className="notif-shade-scrim absolute inset-0 h-auto w-auto cursor-default rounded-none border-0 bg-scrim p-0"
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className={cn(
          "notif-shade-sheet relative flex w-full max-w-md flex-col",
          "px-3 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] outline-none",
        )}
      >
        <span id={labelId} className="sr-only">
          Notifications
        </span>
        {/* Grabber: the pull idiom's handle, and a real close control. */}
        <button
          type="button"
          aria-label="Dismiss notifications"
          data-testid="notifications-shade-grabber"
          onClick={onClose}
          className="group flex min-h-touch w-full items-center justify-center py-1.5"
        >
          <span className="h-1.5 w-10 rounded-full bg-white/45 transition-colors group-hover:bg-white/70" />
        </button>
        {/* The shared inbox card. Self-hides when empty, which can only happen
            mid-session (clear-all with the shade open) — treat that as done. */}
        <NotificationsHomeCenter />
      </section>
    </div>,
    document.body,
  );
}
