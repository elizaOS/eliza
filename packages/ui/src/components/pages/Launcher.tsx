/**
 * Launcher — iOS-like app/view launcher.
 *
 * Renders the curated view tiles as names-only icons on a single scrolling page
 * (the home dashboard is the adjacent page on the rail). Tap launches. There is
 * one flat grid of every visible tile — no favorites, no recents, no section
 * dividers. Composition + visibility are owned by `curateLauncherPages` (system
 * + release always; developer + preview gated by their Settings toggles), so
 * the launcher is READ-ONLY: no reorder, no edit mode, no per-tile pin, no
 * persisted free-form layout. A grid taller than the viewport scrolls
 * vertically; the outer home↔launcher rail owns horizontal navigation in both
 * directions (there is no inner grid pager to arbitrate against).
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
import { Button } from "../ui/button";
import { ViewTileImage } from "../views/ViewTileImage";

export interface LauncherProps {
  entries: ViewEntry[];
  loading?: boolean;
  onLaunch: (entry: ViewEntry) => void;
  className?: string;
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
      className="group relative flex flex-col items-center gap-1.5 select-none"
      data-testid={`launcher-tile-${entry.id}`}
    >
      <div className="relative">
        <Button
          variant="ghost"
          aria-label={entry.label}
          onPointerDown={hold.onPointerDown}
          onPointerMove={hold.onPointerMove}
          onPointerUp={hold.onPointerUp}
          onPointerCancel={hold.onPointerCancel}
          onClickCapture={suppression.onClickCapture}
          onClick={() => onLaunch(entry)}
          className={cn(
            // ViewTileImage renders this surface as an app icon, not as a
            // cropped catalog preview. The button is one constant hit target and
            // owns hover/focus chrome; the inner visual owns color/glyph. Flat —
            // no border; a subtle glass wash is the icon plate (neutral resting →
            // neutral-with-opacity hover).
            "h-16 w-16 overflow-hidden rounded-2xl transition-colors",
            WALLPAPER_GLASS.iconPlate,
            // Neutralize Button's default-size padding (px-4 py-2 letterboxed
            // the artwork into a 32×48 inset) and its [&_svg]:size-4 descendant
            // rule (which would shrink the 28px glyph fallback): the artwork
            // must fill the whole 64×64 icon plate.
            "p-0 [&_svg]:size-7",
          )}
        >
          <ViewTileImage
            entry={entry}
            source="launcher"
            containerClassName="grid h-full w-full place-items-center"
            glyphClassName="h-7 w-7"
            imageTestId={`launcher-image-${entry.id}`}
          />
        </Button>
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
      {/* 5.25rem, not the icon's 4rem: the narrowest grid cell (4 cols on a
          ~380px phone) is ~85px, and the longest single-word label
          ("Relationships", ~79px at 11px) cannot wrap at a word boundary — a
          tighter cap clipped it mid-glyph (#14427). line-clamp-2 still wraps
          multi-word labels. */}
      <span
        className={cn(
          "line-clamp-2 max-w-[5.25rem] text-center text-[11px] font-medium leading-tight",
          WALLPAPER_TEXT.base,
          WALLPAPER_FLOAT_SHADOW,
        )}
      >
        {entry.label}
      </span>
    </div>
  );
});

export function Launcher({
  entries,
  loading = false,
  onLaunch,
  className,
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
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-testid="launcher"
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Single scrolling page — the outer home↔launcher rail owns every
            horizontal gesture, so this container takes no pointer handlers and
            only scrolls vertically when the grid overflows. */}
        <div
          data-testid="launcher-page-window"
          className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto touch-pan-y px-6 pt-2 pb-8"
        >
          <div className="flex w-full max-w-2xl flex-col gap-6">
            {showSkeleton ? (
              <div className="grid w-full grid-cols-4 gap-x-4 gap-y-5 sm:grid-cols-5">
                {["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => (
                  <div
                    key={id}
                    className="flex flex-col items-center gap-1.5 opacity-60"
                  >
                    <div className="h-16 w-16 rounded-2xl bg-white/15" />
                    <div className="h-2.5 w-12 rounded-full bg-white/25" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid w-full grid-cols-4 gap-x-4 gap-y-5 max-sm:portrait:gap-y-8 sm:grid-cols-5">
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
