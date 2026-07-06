/**
 * The bottom-sheet quick-picker that a long-press on the home wallpaper opens
 * (#home-longpress). It is a lightweight ENTRY POINT, not a second system: it
 * renders the shared {@link BackgroundSettingsControls}, so every choice writes
 * to the same background store (`useBackgroundConfig` / `ui-preferences`) that
 * the Settings and Background views use — selections apply live and persist
 * through the identical path, just reached from the home instead of a settings
 * dive.
 *
 * Surfaced via `createPortal` at the shell-overlay z-layer so it floats above
 * the home rail. A tinted scrim dims the home behind it; tapping the scrim, the
 * grabber, or pressing Escape dismisses. The sheet enters with a settle-in
 * translate that stills under prefers-reduced-motion. The sheet shows the
 * gallery's condensed `filmstrip` variant: a horizontal row of live wallpaper
 * tiles plus the make-with-AI and tool affordances, so it reads as the same
 * gallery, just reached from the home.
 */

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { BackgroundSettingsControls } from "../settings/BackgroundSettingsControls";
import { Button } from "../ui/button";

// The sheet's slide-in. Kept local so the picker owns its own motion without
// touching any global keyframe surface; fully stilled under reduced motion so
// the sheet just appears in place. transform/opacity only (composited).
const QUICK_PICKER_CSS = `
@keyframes home-bg-picker-in {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: none; }
}
@keyframes home-bg-picker-scrim-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.home-bg-picker-sheet {
  animation: home-bg-picker-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.home-bg-picker-scrim {
  animation: home-bg-picker-scrim-in 200ms ease-out both;
}
@media (prefers-reduced-motion: reduce) {
  .home-bg-picker-sheet,
  .home-bg-picker-scrim {
    animation: none;
  }
}
`;

export interface HomeBackgroundQuickPickerProps {
  /** Dismiss the picker (scrim tap, grabber, close button, or Escape). */
  onClose: () => void;
}

/**
 * A bottom sheet with the shared background controls. Mounted only while open
 * (the home unmounts it on close), so there is no persistent DOM cost when the
 * picker is not showing.
 */
export function HomeBackgroundQuickPicker({
  onClose,
}: HomeBackgroundQuickPickerProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);

  // Escape closes; focus moves into the sheet on mount so a keyboard user lands
  // on the controls, not back on the home behind the scrim.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    // Defer the focus one frame so the enter animation has committed.
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
      data-testid="home-background-quick-picker"
      className="fixed inset-0 flex items-end justify-center"
      style={{ zIndex: Z_SHELL_OVERLAY + 5 }}
    >
      <style>{QUICK_PICKER_CSS}</style>
      {/* Scrim: dims the home, closes on tap. A plain tinted layer, not a blur
          gate — the wallpaper stays legible through it, just quieted. */}
      <button
        type="button"
        aria-label="Close background picker"
        onClick={onClose}
        className="home-bg-picker-scrim absolute inset-0 h-auto w-auto cursor-default rounded-none border-0 bg-scrim p-0"
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "home-bg-picker-sheet relative flex w-full max-w-md flex-col items-center gap-4",
          "rounded-t-3xl border border-border bg-bg-elevated px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] outline-none",
          // Tint the elevation shadow toward the surface rather than a generic
          // black drop, so the sheet reads as lifted, not pasted on.
          "shadow-[0_-8px_40px_-12px_var(--color-scrim)]",
        )}
      >
        {/* Grabber: the iOS-idiom drag handle. It is also a real close control
            (tap to dismiss) so the affordance is not decorative. */}
        <button
          type="button"
          aria-label="Dismiss background picker"
          onClick={onClose}
          className="group flex min-h-touch w-full items-center justify-center py-2"
        >
          <span className="h-1.5 w-10 rounded-full bg-border-strong transition-colors group-hover:bg-txt/40" />
        </button>

        <header className="flex w-full items-center justify-between">
          <div className="flex flex-col">
            <h2
              id={titleId}
              className="text-base font-semibold text-txt-strong"
            >
              Wallpaper
            </h2>
            <p className="text-xs text-muted">Tap a tile to try it on.</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
            className="h-11 w-11 shrink-0 rounded-full text-muted hover:bg-bg-hover hover:text-txt"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </header>

        <div className="w-full overscroll-contain">
          <BackgroundSettingsControls
            variant="filmstrip"
            className="max-w-none"
          />
        </div>
      </section>
    </div>,
    document.body,
  );
}
