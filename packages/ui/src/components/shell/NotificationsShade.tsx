/**
 * The pull-DOWN notification shade: a sheet that drops from the top of the home
 * to reveal the inbox — the inverse of the chat overlay, which rises from the
 * bottom. HomeScreen reveals it with a downward drag anywhere on the home (or a
 * tap on the top hint) and, in the same motion, collapses the chat; dragging the
 * sheet back UP dismisses it. It renders the shared {@link NotificationsHomeCenter}
 * card, so open / dismiss / mark-all-read all flow through the one notification
 * store, and rows arrive grouped by view, priority-then-newest.
 *
 * Portal-mounted at the shell-overlay z-layer and only while open, so the home
 * pays zero DOM cost at rest and opening never reflows the dashboard — the
 * sheet floats over it (the continuous chat overlay lives above both). Scrim
 * tap, grabber tap, an upward drag past {@link CLOSE_DRAG_PX}, and Escape all
 * dismiss.
 */

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { haptics } from "../../bridge/capacitor-bridge";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { NotificationsHomeCenter } from "./NotificationsHomeCenter";

// Slide-down + scrim fade, local to the shade; transform/opacity only and fully
// stilled under prefers-reduced-motion (the house sheet pattern, inverted to
// drop from the top).
const SHADE_CSS = `
@keyframes notif-shade-in {
  from { opacity: 0; transform: translateY(-24px); }
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

/** Upward drag (px) on the sheet/grabber that dismisses the shade on release. */
const CLOSE_DRAG_PX = 56;

export interface NotificationsShadeProps {
  /** Dismiss the shade (scrim tap, grabber, up-drag, or Escape). */
  onClose: () => void;
}

/** The pull-down sheet wrapping the notification inbox. Mounted only while open. */
export function NotificationsShade({
  onClose,
}: NotificationsShadeProps): React.JSX.Element | null {
  const labelId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  // Live upward-drag offset on the grabber (negative = dragged up).
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ id: number; startY: number } | null>(null);

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
      className="fixed inset-0 flex items-start justify-center"
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
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: drag.current
            ? "none"
            : "transform 200ms cubic-bezier(0.22,1,0.36,1)",
        }}
        className={cn(
          "notif-shade-sheet relative flex w-full max-w-md flex-col",
          "px-3 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] outline-none",
        )}
      >
        <span id={labelId} className="sr-only">
          Notifications
        </span>
        {/* The shared inbox card. Self-hides when empty, which can only happen
            mid-session (clear-all with the shade open) — treat that as done. */}
        <NotificationsHomeCenter onNavigate={() => onClose()} />
        {/* Grabber BELOW the card (the shade drops from the top, so its handle
            sits at the bottom edge): tap or drag UP past CLOSE_DRAG_PX closes. */}
        <button
          type="button"
          aria-label="Dismiss notifications"
          data-testid="notifications-shade-grabber"
          onClick={onClose}
          onPointerDown={(e) => {
            drag.current = { id: e.pointerId, startY: e.clientY };
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current || drag.current.id !== e.pointerId) return;
            // Only track upward travel; a downward drag on the handle does nothing.
            setDragY(Math.min(0, e.clientY - drag.current.startY));
          }}
          onPointerUp={(e) => {
            if (drag.current?.id !== e.pointerId) return;
            const closed = e.clientY - drag.current.startY <= -CLOSE_DRAG_PX;
            drag.current = null;
            if (closed) {
              void haptics.light();
              onClose();
            } else {
              setDragY(0);
            }
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragY(0);
          }}
          className="group mt-1 flex min-h-touch w-full touch-none items-center justify-center py-1.5"
        >
          <span className="h-1.5 w-10 rounded-full bg-white/45 transition-colors group-hover:bg-white/70" />
        </button>
      </section>
    </div>,
    document.body,
  );
}
