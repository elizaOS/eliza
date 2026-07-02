/**
 * Launcher — iOS-like app/view launcher.
 *
 * Renders the curated view tiles as names-only icons on a single page (the home
 * dashboard is the adjacent page on the rail). Tap launches. The launcher is
 * READ-ONLY: page composition + visibility are owned by `curateLauncherPages`
 * (system + release always; developer + preview gated by their Settings
 * toggles), so there is no reorder, no edit mode, and no persisted free-form
 * layout. The only gesture the launcher itself owns is a right-swipe back to the
 * home dashboard (`onEdgeSwipeRight`); the outer home↔launcher rail owns the
 * left-swipe into the launcher.
 *
 * Renders no background of its own — the shared root `AppBackground` shows
 * through, matching the home screen. Tiles, labels, and the skeleton use a FIXED
 * white-on-wallpaper treatment (theme-independent, kept legible by a text-shadow
 * over the ambient field) rather than light/dark theme tokens.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useHorizontalPager } from "../../hooks/useHorizontalPager";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import { emitViewInteraction } from "../../view-telemetry";
import { PagerEdgeButtons } from "../shell/PagerEdgeButtons";
import { ViewTileImage } from "../views/ViewTileImage";

export interface LauncherProps {
  entries: ViewEntry[];
  /**
   * Curated pages as ordered id lists (already deduped + visibility-filtered by
   * `curateLauncherPages`). Normally a single page; each group renders as its
   * own page and never merges into the next. Omitted → one page of every entry
   * (the standalone/story default).
   */
  pageGroups?: string[][];
  loading?: boolean;
  onLaunch: (entry: ViewEntry) => void;
  /** Right-swipe back to the home dashboard. */
  onEdgeSwipeRight?: () => void;
  /**
   * Controlled active page index (owned by the shell-surface store via
   * LauncherSurface); local state otherwise so the component stays usable
   * standalone (stories / isolated tests).
   */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Fires with the rendered page count whenever it changes. */
  onPageCountChange?: (count: number) => void;
  /**
   * Render the inner per-page dots. Off when an outer surface owns the single
   * unified indicator. Defaults to true for standalone usage.
   */
  showPageDots?: boolean;
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
  return (
    <div
      className="flex flex-col items-center gap-1.5 select-none"
      data-testid={`launcher-tile-${entry.id}`}
    >
      <div className="relative">
        <button
          type="button"
          aria-label={entry.label}
          onClick={() => onLaunch(entry)}
          className={cn(
            // ViewTileImage renders this surface as an app icon, not as a
            // cropped catalog preview. The button is one constant hit target and
            // owns hover/focus chrome; the inner visual owns color/glyph. Flat —
            // no border; a subtle glass wash is the icon plate (neutral resting →
            // neutral-with-opacity hover).
            "h-16 w-16 overflow-hidden rounded-2xl bg-white/10 text-white transition-colors hover:bg-white/20",
          )}
        >
          <ViewTileImage
            entry={entry}
            source="launcher"
            containerClassName="grid h-full w-full place-items-center"
            glyphClassName="h-7 w-7"
            imageTestId={`launcher-image-${entry.id}`}
          />
        </button>
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
      <span className="max-w-[4.5rem] truncate text-center text-[11px] font-medium leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]">
        {entry.label}
      </span>
    </div>
  );
});

export function Launcher({
  entries,
  pageGroups,
  loading = false,
  onLaunch,
  onEdgeSwipeRight,
  page: pageProp,
  onPageChange,
  onPageCountChange,
  showPageDots = true,
  className,
}: LauncherProps) {
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  // Active page index is CONTROLLED when the shell-surface store supplies it
  // (via LauncherSurface), local otherwise (stories / isolated tests).
  const pageControlled = pageProp !== undefined;
  const [localPage, setLocalPage] = useState(0);
  const activePage = pageProp ?? localPage;
  const setActivePage = useCallback(
    (next: number) => {
      if (pageControlled) onPageChange?.(next);
      else setLocalPage(next);
    },
    [pageControlled, onPageChange],
  );

  // Each curated group is one page; drop ids with no live entry, drop empty
  // pages. Never chunk — the launcher is a single scrolling page of views. When
  // no groups are supplied (standalone / stories), default to one page of every
  // entry in catalog order.
  const groups = useMemo(
    () => pageGroups ?? [entries.map((e) => e.id)],
    [pageGroups, entries],
  );
  const pages = useMemo(() => {
    const filtered = groups
      .map((group) => group.filter((id) => byId.has(id)))
      .filter((group) => group.length > 0);
    return filtered.length > 0 ? filtered : [[]];
  }, [groups, byId]);

  // Keep the LOCAL active page index in range when the page count shrinks.
  useEffect(() => {
    if (pageControlled) return;
    setLocalPage((p) => Math.min(p, pages.length - 1));
  }, [pages.length, pageControlled]);

  useEffect(() => {
    onPageCountChange?.(pages.length);
  }, [pages.length, onPageCountChange]);
  const clampedPage = Math.min(activePage, pages.length - 1);

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

  // The launcher owns only the right-swipe back to home (`onEdgeSwipeRight`);
  // there is no inter-page view paging (a single curated page), so a left-swipe
  // just rubber-bands. The outer rail owns the home→launcher direction.
  const edgeSwipeRightEnabled = onEdgeSwipeRight != null;
  const pager = useHorizontalPager({
    page: clampedPage,
    pageCount: pages.length,
    enabled: pages.length > 1 || edgeSwipeRightEnabled,
    edgeSwipeRightEnabled,
    onEdgeSwipeRight,
    onPageChange: (nextPage) => {
      setActivePage(nextPage);
      emitViewInteraction({
        source: "launcher",
        action: "page-swipe",
        count: nextPage,
      });
    },
  });

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-testid="launcher"
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={pager.viewportRef}
          data-testid="launcher-page-window"
          className="relative flex min-h-0 flex-1 overflow-hidden touch-pan-y"
          style={{ touchAction: "pan-y" }}
          onPointerDown={pager.handlers.onPointerDown}
          onPointerMove={pager.handlers.onPointerMove}
          onPointerUp={pager.handlers.onPointerUp}
          onPointerCancel={pager.handlers.onPointerCancel}
          onLostPointerCapture={pager.handlers.onLostPointerCapture}
          // Swallow the click a committed swipe-back synthesizes so it can't
          // also tap-launch the tile under the finger.
          onClickCapture={pager.handlers.onClickCapture}
        >
          <div
            ref={pager.railRef}
            data-testid="launcher-page-rail"
            className="flex h-full min-h-0 w-full"
          >
            {loading && entries.length === 0 ? (
              <div className="flex h-full min-h-0 min-w-full items-start justify-center overflow-y-auto px-6 pt-2 pb-8">
                <div className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 max-sm:portrait:gap-y-14 sm:grid-cols-5">
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
              </div>
            ) : (
              pages.map((pageIds, pageIndex) => {
                const active = pageIndex === clampedPage;
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: page index is the page identity.
                    key={`launcher-page-${pageIndex}`}
                    data-testid={`launcher-page-${pageIndex}`}
                    aria-hidden={!active}
                    inert={!active || undefined}
                    style={{ touchAction: "pan-y" }}
                    className={cn(
                      "flex h-full min-h-0 min-w-full items-start justify-center overflow-y-auto px-6 pt-2 pb-8",
                      !active && "pointer-events-none",
                    )}
                  >
                    <div className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 max-sm:portrait:gap-y-14 sm:grid-cols-5">
                      {pageIds.map((id) => {
                        const entry = byId.get(id);
                        if (!entry) return null;
                        return (
                          <div key={id} className="flex justify-center">
                            <IconTile entry={entry} onLaunch={handleLaunch} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Web/desktop `< >` edge buttons (hidden on touch). Self-hide at the
            first/last page — with a single curated page they render nothing. */}
        <PagerEdgeButtons
          idPrefix="launcher"
          canPrev={pager.canPrev}
          canNext={pager.canNext}
          goPrev={pager.goPrev}
          goNext={pager.goNext}
          prevLabel="Previous page"
          nextLabel="Next page"
        />

        {/* Page dots — standalone usage only; a single page renders none. */}
        {showPageDots && pages.length > 1 ? (
          <div className="flex items-center justify-center gap-2 pb-3">
            {pages.map((pageIds, index) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: pages have no stable id; index is the page identity.
                key={`dot-${index}-${pageIds[0] ?? "empty"}`}
                type="button"
                aria-label={`Page ${index + 1}`}
                aria-current={index === clampedPage}
                onClick={() => setActivePage(index)}
                className={cn(
                  "h-2 w-2 rounded-full transition-colors",
                  index === clampedPage ? "bg-accent" : "bg-border",
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
