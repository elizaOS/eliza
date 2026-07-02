/**
 * Launcher — iOS-like app/view launcher.
 *
 * Renders every available view as a names-only icon on swipeable pages. Tap
 * launches; long-press enters edit mode where icons can be reordered (drag)
 * and — for manageable (dynamic developer) views — edited or deleted. Page
 * order is persisted via the pure `launcher-layout` model. Fully token-themed
 * (light/dark + overrides) and renders no background of its own — the shared
 * root `AppBackground` shows through, matching the home screen.
 */

import { Pencil, Trash2 } from "lucide-react";
import { Reorder } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHorizontalPager } from "../../hooks/useHorizontalPager";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import {
  LAUNCHER_PAGE_SIZE,
  type LauncherLayout,
  moveIcon,
  readLauncherLayout,
  reconcileLayout,
  writeLauncherLayout,
} from "../../state/launcher-layout";
import { emitViewInteraction } from "../../view-telemetry";
import { PagerEdgeButtons } from "../shell/PagerEdgeButtons";
import { ViewTileImage } from "../views/ViewTileImage";

export interface LauncherProps {
  entries: ViewEntry[];
  /**
   * Explicit, curated pages as ordered id lists (page 1 = apps, page 2 =
   * developer). When supplied the launcher renders these fixed pages read-only
   * (no reorder / edit mode) instead of the persisted free-form layout; a group
   * longer than one page paginates but never merges into the next group. Omit
   * for the standalone/free-form launcher (stories, tests).
   */
  pageGroups?: string[][];
  loading?: boolean;
  onLaunch: (entry: ViewEntry) => void;
  onEdgeSwipeRight?: () => void;
  /** Per-tile management for dynamic views, shown in edit mode when allowed. */
  canManageView?: (id: string) => boolean;
  onEditView?: (id: string) => void;
  onDeleteView?: (id: string) => void;
  /**
   * Controlled active page index. When provided the page is owned by the caller
   * (the shell-surface store, via LauncherSurface); when omitted it is local
   * state so the component stays usable standalone (stories / isolated tests).
   */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Fires with the rendered page count whenever it changes, so an outer surface
   *  can size the unified page indicator. */
  onPageCountChange?: (count: number) => void;
  /** Controlled edit mode. When omitted, edit mode is local state. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /**
   * Render the inner per-page dots. Off when an outer surface (the rail) owns
   * the single unified indicator — this is what prevents two stacked dot strips
   * (#4). Defaults to true for standalone usage.
   */
  showPageDots?: boolean;
  className?: string;
}

interface IconTileProps {
  entry: ViewEntry;
  editing: boolean;
  manageable: boolean;
  onLaunch: (entry: ViewEntry) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onLongPress: () => void;
}

const LONG_PRESS_MS = 450;
/** Finger travel (px) that aborts a long-press — a pan/swipe is not a press, so
 *  a horizontal swipe-back can never ghost-fire edit mode mid-gesture. */
const LONG_PRESS_MOVE_SLOP = 10;

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

// Memoized so a layout reconcile (install/uninstall/sort) re-renders only the
// tiles whose props actually changed, not all ~20 on a page.
const IconTile = memo(function IconTile({
  entry,
  editing,
  manageable,
  onLaunch,
  onEdit,
  onDelete,
  onLongPress,
}: IconTileProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const badge = viewKindBadge(entry);

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pressStart.current = null;
  };

  return (
    <div
      className="flex flex-col items-center gap-1.5 select-none"
      data-testid={`launcher-tile-${entry.id}`}
    >
      <div className="relative">
        <button
          type="button"
          aria-label={entry.label}
          onClick={() => {
            if (!editing) onLaunch(entry);
          }}
          onPointerDown={(event) => {
            clear();
            pressStart.current = { x: event.clientX, y: event.clientY };
            timer.current = setTimeout(onLongPress, LONG_PRESS_MS);
          }}
          // A long-press requires a near-stationary finger: once movement passes
          // LONG_PRESS_MOVE_SLOP the press is a pan/swipe, so cancel the timer.
          // This is what stops a horizontal swipe-back (which keeps the pointer
          // over the translating tile) from ghost-firing edit mode (#3).
          onPointerMove={(event) => {
            const start = pressStart.current;
            if (!start) return;
            if (
              Math.hypot(event.clientX - start.x, event.clientY - start.y) >
              LONG_PRESS_MOVE_SLOP
            ) {
              clear();
            }
          }}
          onPointerUp={clear}
          onPointerLeave={clear}
          // pointercancel (not pointerup) fires when a touch scroll or system
          // gesture interrupts the press — clear the timer so a long-press never
          // ghost-fires edit mode after the user finishes scrolling.
          onPointerCancel={clear}
          className={cn(
            // ViewTileImage renders this surface as an app icon, not as a
            // cropped catalog preview. The button stays one constant hit target
            // and owns hover/focus chrome; the inner visual owns color/glyph.
            // Flat — no border; a subtle glass wash is the icon plate
            // (neutral resting → neutral-with-opacity hover).
            "h-16 w-16 overflow-hidden rounded-2xl bg-white/10 text-white transition-colors hover:bg-white/20",
            editing && "animate-pulse",
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
        {editing && manageable ? (
          <div className="absolute -left-1.5 -top-1.5 flex gap-1">
            {onEdit ? (
              <button
                type="button"
                aria-label={`Edit ${entry.label}`}
                data-testid={`launcher-edit-${entry.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(entry.id);
                }}
                className="grid h-5 w-5 place-items-center rounded-full bg-bg-accent text-foreground"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                aria-label={`Delete ${entry.label}`}
                data-testid={`launcher-delete-${entry.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(entry.id);
                }}
                className="grid h-5 w-5 place-items-center rounded-full bg-destructive/80 text-destructive-foreground"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            ) : null}
          </div>
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
  canManageView,
  onEditView,
  onDeleteView,
  page: pageProp,
  onPageChange,
  onPageCountChange,
  editing: editingProp,
  onEditingChange,
  showPageDots = true,
  className,
}: LauncherProps) {
  // Curated mode: the caller owns page composition, so the launcher renders
  // those fixed pages and disables the free-form layout / edit affordances.
  const grouped = pageGroups != null;
  const availableIds = useMemo(() => entries.map((e) => e.id), [entries]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const [layout, setLayout] = useState<LauncherLayout>(() => {
    const stored = readLauncherLayout();
    return reconcileLayout(stored, availableIds);
  });

  // Active page index + edit mode are CONTROLLED when the caller (the
  // shell-surface store, via LauncherSurface) supplies them, and local
  // otherwise — so the app has one source of truth (the store enforces the
  // "leaving the launcher clears edit mode + page" invariant) while the
  // component stays usable standalone (stories / isolated tests).
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

  const editingControlled = editingProp !== undefined;
  const [localEditing, setLocalEditing] = useState(false);
  // Curated pages are read-only: never enter reorder edit mode.
  const editing = grouped ? false : (editingProp ?? localEditing);
  const setEditingState = useCallback(
    (next: boolean) => {
      if (editingControlled) onEditingChange?.(next);
      else setLocalEditing(next);
    },
    [editingControlled, onEditingChange],
  );

  // Re-reconcile when the available views change (install/uninstall/sort).
  useEffect(() => {
    setLayout((prev) => reconcileLayout(prev, availableIds));
  }, [availableIds]);

  // Keep the LOCAL active page index in range when pages shrink (views removed).
  // When controlled, the store clamps the page, so this only guards the
  // standalone path.
  useEffect(() => {
    if (pageControlled) return;
    const pageCount = layout.pages.length > 0 ? layout.pages.length : 1;
    setLocalPage((p) => (p > pageCount - 1 ? pageCount - 1 : p));
  }, [layout.pages.length, pageControlled]);

  const commit = useCallback((next: LauncherLayout) => {
    setLayout(next);
    writeLauncherLayout(next);
  }, []);

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

  const toggleEditMode = useCallback(() => {
    if (grouped) return; // Curated pages never enter edit mode.
    emitViewInteraction({
      source: "launcher",
      action: editing ? "edit-mode-exit" : "edit-mode-enter",
    });
    setEditingState(!editing);
  }, [grouped, editing, setEditingState]);

  // Curated mode chunks each supplied group onto its own page(s) so a group
  // boundary always starts a fresh page (page 1 = apps, page 2 = developer),
  // never merging two groups even when the first is short.
  const curatedPages = useMemo(() => {
    if (!pageGroups) return null;
    const result: string[][] = [];
    for (const group of pageGroups) {
      const present = group.filter((id) => byId.has(id));
      for (let i = 0; i < present.length; i += LAUNCHER_PAGE_SIZE) {
        result.push(present.slice(i, i + LAUNCHER_PAGE_SIZE));
      }
    }
    return result.length > 0 ? result : [[]];
  }, [pageGroups, byId]);

  const pages = useMemo(() => {
    const sourcePages =
      curatedPages ?? (layout.pages.length > 0 ? layout.pages : [[]]);
    const filtered = sourcePages.filter((page) => page.length > 0);
    return filtered.length > 0 ? filtered : [[]];
  }, [curatedPages, layout.pages]);

  // Report the page count up so an outer surface (the rail) can size the single
  // unified page indicator. Fires only on an actual count change.
  useEffect(() => {
    onPageCountChange?.(pages.length);
  }, [pages.length, onPageCountChange]);
  const clampedPage = Math.min(activePage, pages.length - 1);

  const handleReorder = useCallback(
    (pageIndex: number, nextIds: string[]) => {
      // Rebuild the layout for this page from the reordered id list.
      let next = layout;
      nextIds.forEach((id, index) => {
        next = moveIcon(next, id, pageIndex, index);
      });
      emitViewInteraction({
        source: "launcher",
        action: "reorder",
        count: pageIndex,
      });
      commit(next);
    },
    [layout, commit],
  );

  const renderTile = useCallback(
    (entry: ViewEntry) => (
      <IconTile
        entry={entry}
        editing={editing}
        manageable={canManageView?.(entry.id) ?? false}
        onLaunch={handleLaunch}
        onEdit={onEditView}
        onDelete={onDeleteView}
        onLongPress={toggleEditMode}
      />
    ),
    [
      editing,
      canManageView,
      handleLaunch,
      onEditView,
      onDeleteView,
      toggleEditMode,
    ],
  );

  // The launcher owns EVERY horizontal gesture on its surface — inter-page
  // paging AND the swipe-right-back-to-home (via onEdgeSwipeRight). Decoupling
  // the edge-swipe from `showPageDots` is what lets the outer home↔launcher rail
  // stand down entirely while the launcher is showing, so a swipe is tracked by
  // exactly one pager instead of two stacked ones. The pager stays enabled for a
  // single-page launcher too when the edge-swipe-home is available (otherwise a
  // one-page launcher would have no way back).
  const edgeSwipeRightEnabled = onEdgeSwipeRight != null;
  const pager = useHorizontalPager({
    page: clampedPage,
    pageCount: pages.length,
    enabled: !editing && (pages.length > 1 || edgeSwipeRightEnabled),
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
      {/* Swipeable pages. Swipe paging is active only outside edit mode, so it
          never fights the in-tile drag-to-reorder gesture. A real rail is
          rendered so adjacent pages move with the finger, instead of swapping
          page contents after release. */}
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
        >
          <div
            ref={pager.railRef}
            data-testid="launcher-page-rail"
            className="flex h-full min-h-0 w-full motion-reduce:transition-none"
          >
            {loading && entries.length === 0 ? (
              <div className="flex h-full min-h-0 min-w-full items-start justify-center overflow-y-auto px-6 pt-2 pb-8">
                <div className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 portrait:gap-y-14 sm:grid-cols-5 sm:gap-y-5">
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
                    // biome-ignore lint/suspicious/noArrayIndexKey: page index is the persisted page identity.
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
                    {editing && active ? (
                      <Reorder.Group
                        axis="y"
                        values={pageIds}
                        onReorder={(next) =>
                          handleReorder(pageIndex, next as string[])
                        }
                        className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 portrait:gap-y-14 sm:grid-cols-5 sm:gap-y-5"
                      >
                        {pageIds.map((id) => {
                          const entry = byId.get(id);
                          if (!entry) return null;
                          return (
                            <Reorder.Item
                              key={id}
                              value={id}
                              drag={editing}
                              dragListener={editing}
                              className="flex justify-center"
                            >
                              {renderTile(entry)}
                            </Reorder.Item>
                          );
                        })}
                      </Reorder.Group>
                    ) : (
                      <div className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 portrait:gap-y-14 sm:grid-cols-5 sm:gap-y-5">
                        {pageIds.map((id) => {
                          const entry = byId.get(id);
                          if (!entry) return null;
                          return (
                            <div key={id} className="flex justify-center">
                              {renderTile(entry)}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Web/desktop `< >` edge buttons (hidden on touch, and while editing so
            they never fight the reorder gesture). Self-hide at the first/last
            page via canPrev/canNext. */}
        {!editing ? (
          <PagerEdgeButtons
            idPrefix="launcher"
            canPrev={pager.canPrev}
            canNext={pager.canNext}
            goPrev={pager.goPrev}
            goNext={pager.goNext}
            prevLabel="Previous page"
            nextLabel="Next page"
          />
        ) : null}

        {/* Page dots — rendered only for STANDALONE usage. When nested in the
            home/launcher rail, `showPageDots` is false and the rail owns the
            single unified indicator, so two dot strips never stack (#4). */}
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
