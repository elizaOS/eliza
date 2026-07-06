/**
 * Launcher — iOS-like app/view launcher.
 *
 * Renders the curated view tiles as names-only icons on a single scrolling page
 * (the home dashboard is the adjacent page on the rail). Tap launches. Tiles are
 * grouped into named zones — Recents, Favorites, All Apps — composed by
 * `curateLauncherZones`; Recents/Favorites are projections over the same curated
 * page and only render when non-empty, so the default first-run launcher is just
 * "All Apps". The launcher is otherwise READ-ONLY: composition + visibility are
 * owned by `curateLauncherPages` (system + release always; developer + preview
 * gated by their Settings toggles), so there is no reorder, no edit mode, and no
 * persisted free-form layout beyond the per-tile favorite pin. A grid taller than
 * the viewport scrolls vertically; the outer home↔launcher rail owns horizontal
 * navigation in both directions (there is no inner grid pager to arbitrate
 * against).
 *
 * Renders no background of its own — the shared root `AppBackground` shows
 * through, matching the home screen. Tiles, labels, and the skeleton use a FIXED
 * white-on-wallpaper treatment (theme-independent, kept legible by a text-shadow
 * over the ambient field) rather than light/dark theme tokens.
 */

import { Star } from "lucide-react";
import { memo, useCallback } from "react";
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
import type { LauncherZone } from "./launcher-curation";

export interface LauncherProps {
  zones: LauncherZone[];
  loading?: boolean;
  onLaunch: (entry: ViewEntry) => void;
  /** Toggle a view's Favorites pin. Omit to hide the per-tile star affordance. */
  onToggleFavorite?: (entry: ViewEntry) => void;
  /** Canonical ids currently pinned — drives the filled-star state. */
  favoriteIds?: ReadonlySet<string>;
  className?: string;
}

interface IconTileProps {
  entry: ViewEntry;
  /** Zone-unique testid prefix so a tile shown in two zones stays addressable. */
  testIdPrefix: string;
  onLaunch: (entry: ViewEntry) => void;
  onToggleFavorite?: (entry: ViewEntry) => void;
  isFavorite: boolean;
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
const IconTile = memo(function IconTile({
  entry,
  testIdPrefix,
  onLaunch,
  onToggleFavorite,
  isFavorite,
}: IconTileProps) {
  const badge = viewKindBadge(entry);
  return (
    <div
      className="group relative flex flex-col items-center gap-1.5 select-none"
      data-testid={`${testIdPrefix}-${entry.id}`}
    >
      <div className="relative">
        <Button
          variant="ghost"
          aria-label={entry.label}
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
        {onToggleFavorite ? (
          // The pin lives on the tile itself (the only place a launcher-scoped
          // favorite has meaning). Fine pointers keep the quiet hover/focus
          // reveal, while coarse pointers get a visible 44px target at rest so
          // Favorites can be managed on the phone-primary surface.
          <Button
            unstyled
            data-testid={`launcher-favorite-${entry.id}`}
            aria-pressed={isFavorite}
            aria-label={
              isFavorite
                ? `Unpin ${entry.label} from Favorites`
                : `Pin ${entry.label} to Favorites`
            }
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(entry);
            }}
            className={cn(
              "absolute -right-3.5 -top-3.5 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/50 bg-card/85 p-0 text-card-foreground shadow-sm transition-[background-color,opacity,transform] active:scale-[0.98] hover:bg-card",
              isFavorite
                ? "text-warn opacity-100"
                : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <Star
              className="h-4 w-4"
              fill={isFavorite ? "currentColor" : "none"}
              aria-hidden
            />
          </Button>
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

function LauncherGrid({
  entries,
  testIdPrefix,
  onLaunch,
  onToggleFavorite,
  favoriteIds,
}: {
  entries: ViewEntry[];
  testIdPrefix: string;
  onLaunch: (entry: ViewEntry) => void;
  onToggleFavorite?: (entry: ViewEntry) => void;
  favoriteIds?: ReadonlySet<string>;
}) {
  return (
    <div className="grid w-full grid-cols-4 gap-x-4 gap-y-5 max-sm:portrait:gap-y-8 sm:grid-cols-5">
      {entries.map((entry) => (
        <div key={entry.id} className="flex justify-center">
          <IconTile
            entry={entry}
            testIdPrefix={testIdPrefix}
            onLaunch={onLaunch}
            onToggleFavorite={onToggleFavorite}
            isFavorite={favoriteIds?.has(entry.id) ?? false}
          />
        </div>
      ))}
    </div>
  );
}

function ZoneHeader({ label }: { label: string }) {
  // Minimal section header — a small uppercase label and a hairline rule, no
  // card chrome (the launcher paints straight onto the wallpaper).
  return (
    <div className="flex items-center gap-3 px-1">
      <h2
        className={cn(
          "text-[11px] font-semibold uppercase tracking-[0.14em]",
          WALLPAPER_TEXT.primary,
          WALLPAPER_FLOAT_SHADOW,
        )}
      >
        {label}
      </h2>
      <div className="h-px flex-1 bg-white/20" />
    </div>
  );
}

export function Launcher({
  zones,
  loading = false,
  onLaunch,
  onToggleFavorite,
  favoriteIds,
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

  const allZone = zones.find((zone) => zone.key === "all");
  const showSkeleton = loading && (allZone?.entries.length ?? 0) === 0;
  // Recents/Favorites only render when populated; the "All Apps" heading is
  // dropped when it is the sole zone so the default launcher stays a plain grid.
  const secondaryZones = zones.filter(
    (zone) => zone.key !== "all" && zone.entries.length > 0,
  );
  const showZoneHeaders = secondaryZones.length > 0;

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
              zones.map((zone) => {
                if (zone.entries.length === 0) return null;
                const isAll = zone.key === "all";
                return (
                  <section
                    key={zone.key}
                    data-testid={`launcher-zone-${zone.key}`}
                    className="flex flex-col gap-3"
                  >
                    {showZoneHeaders ? <ZoneHeader label={zone.label} /> : null}
                    <LauncherGrid
                      entries={zone.entries}
                      // Only the exhaustive "All Apps" zone owns the canonical
                      // `launcher-tile-<id>` testid; the projection zones use
                      // zone-scoped prefixes so a tile shown twice stays uniquely
                      // addressable and the "one tile per id" contract holds.
                      testIdPrefix={
                        isAll ? "launcher-tile" : `launcher-${zone.key}-tile`
                      }
                      onLaunch={handleLaunch}
                      // The pin only makes sense on the exhaustive grid; the
                      // projection zones render read-only.
                      onToggleFavorite={isAll ? onToggleFavorite : undefined}
                      favoriteIds={favoriteIds}
                    />
                  </section>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
