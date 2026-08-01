/**
 * Launcher — iOS-like app/view launcher.
 *
 * Renders the curated view tiles as names-only icons in one grid. Tap launches. There is
 * one flat grid of every visible tile — no favorites, no recents, no section
 * dividers. Composition + visibility are owned by `curateLauncherPages` (system
 * + release always; developer + preview gated by their Settings toggles), so
 * the launcher is READ-ONLY: no reorder, no edit mode, no per-tile pin, no
 * persisted free-form layout. A standalone grid scrolls vertically; when
 * embedded on Home, the bounded Home app region owns that same vertical scroll.
 *
 * Renders no background of its own — the shared root `AppBackground` shows
 * through, matching the home screen. Tiles, labels, and the skeleton use a FIXED
 * white-on-wallpaper treatment (theme-independent, kept legible by a text-shadow
 * over the ambient field) rather than light/dark theme tokens.
 */

import { memo, useCallback } from "react";
import { useClickSuppression } from "../../gestures/useClickSuppression";
import { usePointerPressAndHold } from "../../gestures/usePointerPressAndHold";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import { emitViewInteraction } from "../../view-telemetry";
import {
  WALLPAPER_FLOAT_SHADOW,
  WALLPAPER_GLASS,
  WALLPAPER_TEXT,
} from "../shell/wallpaper-idiom";
import { ViewTileImage } from "../views/ViewTileImage";

const LAUNCHER_RESPONSIVE_CSS = `
[data-testid="launcher"] { container-type: inline-size; }
[data-testid="launcher"] [data-launcher-icon] {
  width: clamp(3.5rem, 16cqi, 4.5rem);
  height: clamp(3.5rem, 16cqi, 4.5rem);
  border-radius: clamp(1rem, 4cqi, 1.25rem);
}
[data-testid="launcher"] [data-launcher-label] {
  font-size: clamp(.75rem, calc(.68rem + .25cqi), .875rem);
}
[data-testid="launcher"] [data-launcher-label][data-compact-label="true"] {
  font-size: .75rem;
}
@media (orientation: landscape) and (max-height: 520px) {
  [data-testid="launcher"] [data-launcher-icon] { width: 3.5rem; height: 3.5rem; }
}
`;

export interface LauncherProps {
  entries: ViewEntry[];
  loading?: boolean;
  onLaunch: (entry: ViewEntry) => void;
  className?: string;
  /** Render at natural height inside Home's app scroll region. */
  embedded?: boolean;
}

interface IconTileProps {
  entry: ViewEntry;
  onLaunch: (entry: ViewEntry) => void;
}

function viewKindBadge(entry: ViewEntry): {
  label: string;
  title: string;
} | null {
  if (entry.viewKind === "preview") {
    return {
      label: "Preview",
      title: `${entry.label} is marked preview`,
    };
  }
  if (entry.viewKind === "developer" || entry.developerOnly === true) {
    return {
      label: "Dev",
      title: `${entry.label} is marked developer`,
    };
  }
  return null;
}

// Memoized so a catalog change (install/uninstall/sort) re-renders only the
// tiles whose props actually changed, not the whole page.
const IconTile = memo(function IconTile({ entry, onLaunch }: IconTileProps) {
  const badge = viewKindBadge(entry);
  const hasLongUnbrokenLabel = entry.label
    .split(/\s+/)
    .some((word) => word.length > 10);
  // A long stationary press must NOT ghost-launch on release: the browser
  // synthesizes a compat click from that same press, and a bare onClick would
  // launch whatever tile the finger held (the gesture-matrix "no ghost-launch"
  // contract). The launcher is read-only — a hold has no action of its own —
  // so the hold only ARMS click suppression and the release is inert. A tap
  // (release before the 450ms hold) clears the timer and launches normally;
  // travel past the slop cancels the hold so scroll-drags keep their own
  // semantics. autoDisarm:false because the synthesized click can land a task
  // after the hold fires (touch); consume-on-click still disarms immediately.
  const suppression = useClickSuppression({ autoDisarm: false });
  const hold = usePointerPressAndHold<HTMLButtonElement>({
    onHold: suppression.arm,
  });
  return (
    <div
      className="flex justify-center"
      data-testid={`launcher-tile-${entry.id}`}
    >
      <button
        type="button"
        aria-label={entry.label}
        onPointerDown={hold.onPointerDown}
        onPointerMove={hold.onPointerMove}
        onPointerUp={hold.onPointerUp}
        onPointerCancel={hold.onPointerCancel}
        onClickCapture={suppression.onClickCapture}
        onClick={() => onLaunch(entry)}
        className="group relative flex max-w-[5.5rem] flex-col items-center gap-1.5 rounded-2xl select-none"
      >
        <div className="relative">
          <div
            data-launcher-icon=""
            className={cn(
              // ViewTileImage renders this surface as an app icon, not as a
              // cropped catalog preview. The tile stays a generous hit target,
              // compacting only on short landscape screens so its label clears
              // chat; the inner visual owns color/glyph. Flat — no border; a
              // subtle glass wash is the icon plate (neutral resting →
              // neutral-with-opacity hover).
              "h-16 w-16 overflow-hidden rounded-2xl transition-colors [@media(orientation:landscape)_and_(max-height:520px)]:h-14 [@media(orientation:landscape)_and_(max-height:520px)]:w-14",
              WALLPAPER_GLASS.iconPlate,
              // Hovering the label highlights the same icon plate.
              "group-hover:bg-white/20",
            )}
          >
            <ViewTileImage
              entry={entry}
              source="launcher"
              containerClassName="grid h-full w-full place-items-center"
              glyphClassName="size-[clamp(1.5rem,7cqi,2rem)]"
              imageTestId={`launcher-image-${entry.id}`}
            />
          </div>
          {badge ? (
            <span
              data-testid={`launcher-kind-${entry.id}`}
              title={badge.title}
              className="pointer-events-none absolute -left-1.5 -bottom-1 max-w-[3.75rem] truncate rounded-full bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none text-neutral-900"
            >
              {badge.label}
            </span>
          ) : null}
        </div>
        {/* 5.5rem, not the icon's 4rem: the narrowest grid cell (4 cols on a
            ~380px phone) leaves just enough room for the longest single-word
            label while keeping OCR-readable 12px copy from clipping mid-glyph
            (#14427). line-clamp-2 still wraps multi-word labels. */}
        <span
          data-launcher-label=""
          data-compact-label={hasLongUnbrokenLabel || undefined}
          className={cn(
            "line-clamp-2 max-w-[5.5rem] text-center text-xs font-semibold leading-tight tracking-normal whitespace-normal",
            WALLPAPER_TEXT.base,
            WALLPAPER_FLOAT_SHADOW,
          )}
        >
          {entry.label}
        </span>
      </button>
    </div>
  );
});

export function Launcher({
  entries,
  loading = false,
  onLaunch,
  className,
  embedded = false,
}: LauncherProps) {
  const handleLaunch = useCallback(
    (entry: ViewEntry) => {
      emitViewInteraction({
        source: "launcher",
        action: "launch",
        viewId: entry.id,
      });
      onLaunch(entry);
    },
    [onLaunch],
  );

  const showSkeleton = loading && entries.length === 0;

  return (
    <div
      className={cn("flex flex-col", !embedded && "min-h-0 flex-1", className)}
      data-testid="launcher"
      aria-busy={showSkeleton || undefined}
    >
      <style>{LAUNCHER_RESPONSIVE_CSS}</style>
      <div
        className={cn(
          "relative flex flex-col",
          !embedded && "min-h-0 flex-1 overflow-hidden",
        )}
      >
        {/* The full-page variant owns vertical overflow; Home's embedded variant
            stays natural-height so the shared app region is the sole scroller.
            The full-page scroll port itself ends above chat. Bottom padding
            alone would make the last row reachable but still paint it beneath
            the resting composer before the user scrolls. */}
        <div
          data-testid="launcher-page-window"
          className={cn(
            "scrollbar-hide relative flex touch-pan-y flex-col items-center overscroll-y-contain pt-2 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden",
            embedded
              ? "overflow-visible px-2 pb-8 [@media(orientation:landscape)_and_(max-height:520px)]:pt-0"
              : "scroll-fade scroll-fade-t-[3.5rem] scroll-fade-b-[1.25rem] [--scroll-fade-reveal:1px] min-h-0 flex-1 mb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-chat-clearance,5.25rem)+1rem)] scroll-pb-7 overflow-y-auto ps-6 pe-[calc(1.5rem+var(--eliza-chat-side-clearance,0px))] pb-7",
          )}
        >
          <div className="flex w-full max-w-2xl flex-col gap-6">
            {showSkeleton ? (
              <div className="grid w-full grid-cols-3 gap-x-4 gap-y-5 min-[360px]:grid-cols-4 sm:grid-cols-5">
                {["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => (
                  <div
                    key={id}
                    className="flex flex-col items-center gap-1.5 opacity-60"
                  >
                    <div
                      data-launcher-icon=""
                      className="h-16 w-16 rounded-2xl bg-white/15"
                    />
                    <div className="h-2.5 w-12 rounded-full bg-white/25" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid w-full grid-cols-3 gap-x-4 gap-y-5 min-[360px]:grid-cols-4 max-sm:portrait:gap-y-8 sm:grid-cols-5">
                {entries.map((entry) => (
                  <div key={entry.id} className="flex justify-center">
                    <IconTile entry={entry} onLaunch={handleLaunch} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
