/**
 * Springboard — iOS-like app/view launcher.
 *
 * Renders every available view as a names-only icon on swipeable pages plus a
 * pinned favorites dock. Tap launches; long-press enters edit mode where icons
 * can be reordered (drag), favorited into the dock, and — for manageable
 * (dynamic developer) views — edited or deleted. Page order is persisted via
 * the pure `springboard-layout` model. Favorites are
 * controlled-optional: when `onToggleFavorite` is supplied the dock reflects the
 * caller's `favoriteIds`; otherwise favorites are kept locally. Fully
 * token-themed (light/dark + overrides) and renders no background of its own —
 * the shared root `AppBackground` shows through, matching the home screen.
 */

import { Pencil, Trash2 } from "lucide-react";
import { Reorder } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHorizontalPager } from "../../hooks/useHorizontalPager";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import {
  moveIcon,
  readSpringboardLayout,
  reconcileLayout,
  SPRINGBOARD_DOCK_LIMIT,
  type SpringboardLayout,
  toggleFavorite,
  writeSpringboardLayout,
} from "../../state/springboard-layout";
import { emitViewInteraction } from "../../view-telemetry";
import { ViewTileImage } from "../views/ViewTileImage";

export interface SpringboardProps {
  entries: ViewEntry[];
  loading?: boolean;
  onLaunch: (entry: ViewEntry) => void;
  onEdgeSwipeRight?: () => void;
  /** When set, favorites are controlled by the caller (e.g. desktop tabs). */
  favoriteIds?: string[];
  onToggleFavorite?: (id: string) => void;
  /** Per-tile management for dynamic views, shown in edit mode when allowed. */
  canManageView?: (id: string) => boolean;
  onEditView?: (id: string) => void;
  onDeleteView?: (id: string) => void;
  /**
   * Controlled active page index. When provided the page is owned by the caller
   * (the shell-surface store, via SpringboardSurface); when omitted it is local
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
  favorited: boolean;
  manageable: boolean;
  onLaunch: (entry: ViewEntry) => void;
  onToggleFavorite: (id: string) => void;
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
  favorited,
  manageable,
  onLaunch,
  onToggleFavorite,
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
      data-testid={`springboard-tile-${entry.id}`}
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
            "h-16 w-16 overflow-hidden rounded-2xl border border-white/10 bg-black/35 text-white transition-colors hover:bg-black/45",
            editing && "animate-pulse",
          )}
        >
          <ViewTileImage
            entry={entry}
            source="springboard"
            containerClassName="grid h-full w-full place-items-center"
            glyphClassName="h-7 w-7"
            imageTestId={`springboard-image-${entry.id}`}
          />
        </button>
        {badge ? (
          <span
            data-testid={`springboard-kind-${entry.id}`}
            title={badge.title}
            className="pointer-events-none absolute -left-1.5 -bottom-1 max-w-[3.75rem] truncate rounded-full border border-black/20 bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none text-neutral-900 shadow-sm"
          >
            {badge.label}
          </span>
        ) : null}
        {editing ? (
          <button
            type="button"
            aria-label={
              favorited ? `Unpin ${entry.label}` : `Pin ${entry.label}`
            }
            data-testid={`springboard-fav-${entry.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(entry.id);
            }}
            className={cn(
              // Filled chips stay legible across image and dark tile backgrounds.
              "absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border text-[11px] font-bold shadow-md",
              favorited
                ? "border-black/20 bg-accent text-white"
                : "border-black/15 bg-white text-neutral-900",
            )}
          >
            {favorited ? "★" : "+"}
          </button>
        ) : null}
        {editing && manageable ? (
          <div className="absolute -left-1.5 -top-1.5 flex gap-1">
            {onEdit ? (
              <button
                type="button"
                aria-label={`Edit ${entry.label}`}
                data-testid={`springboard-edit-${entry.id}`}
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
                data-testid={`springboard-delete-${entry.id}`}
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

export function Springboard({
  entries,
  loading = false,
  onLaunch,
  onEdgeSwipeRight,
  favoriteIds,
  onToggleFavorite,
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
}: SpringboardProps) {
  const availableIds = useMemo(() => entries.map((e) => e.id), [entries]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const controlled = onToggleFavorite != null;
  const favorites = useMemo(
    () => (controlled ? (favoriteIds ?? []) : null),
    [controlled, favoriteIds],
  );

  const [layout, setLayout] = useState<SpringboardLayout>(() => {
    const stored = readSpringboardLayout();
    return reconcileLayout(
      { favorites: favorites ?? stored.favorites, pages: stored.pages },
      entries.map((e) => e.id),
    );
  });

  // Active page index + edit mode are CONTROLLED when the caller (the
  // shell-surface store, via SpringboardSurface) supplies them, and local
  // otherwise — so the app has one source of truth (the store enforces the
  // "leaving the springboard clears edit mode + page" invariant) while the
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
  const editing = editingProp ?? localEditing;
  const setEditingState = useCallback(
    (next: boolean) => {
      if (editingControlled) onEditingChange?.(next);
      else setLocalEditing(next);
    },
    [editingControlled, onEditingChange],
  );

  // Re-reconcile when the available views or controlled favorites change.
  useEffect(() => {
    setLayout((prev) =>
      reconcileLayout(
        { favorites: favorites ?? prev.favorites, pages: prev.pages },
        availableIds,
      ),
    );
  }, [availableIds, favorites]);

  // Keep the LOCAL active page index in range when pages shrink (views removed).
  // When controlled, the store clamps the page, so this only guards the
  // standalone path.
  useEffect(() => {
    if (pageControlled) return;
    const pageCount = layout.pages.length > 0 ? layout.pages.length : 1;
    setLocalPage((p) => (p > pageCount - 1 ? pageCount - 1 : p));
  }, [layout.pages.length, pageControlled]);

  const commit = useCallback((next: SpringboardLayout) => {
    setLayout(next);
    writeSpringboardLayout(next);
  }, []);

  const toggleFav = useCallback(
    (id: string) => {
      const wasFavorited = (favorites ?? layout.favorites).includes(id);
      emitViewInteraction({
        source: "springboard",
        action: wasFavorited ? "unfavorite" : "favorite",
        viewId: id,
      });
      if (controlled) {
        onToggleFavorite?.(id);
        return;
      }
      commit(reconcileLayout(toggleFavorite(layout, id), availableIds));
    },
    [controlled, onToggleFavorite, commit, layout, availableIds, favorites],
  );

  const handleLaunch = useCallback(
    (entry: ViewEntry) => {
      emitViewInteraction({
        source: "springboard",
        action: "launch",
        viewId: entry.id,
      });
      onLaunch(entry);
    },
    [onLaunch],
  );

  const toggleEditMode = useCallback(() => {
    emitViewInteraction({
      source: "springboard",
      action: editing ? "edit-mode-exit" : "edit-mode-enter",
    });
    setEditingState(!editing);
  }, [editing, setEditingState]);

  const pages = useMemo(
    () => (layout.pages.length > 0 ? layout.pages : [[]]),
    [layout.pages],
  );

  // Report the page count up so an outer surface (the rail) can size the single
  // unified page indicator. Fires only on an actual count change.
  useEffect(() => {
    onPageCountChange?.(pages.length);
  }, [pages.length, onPageCountChange]);
  const clampedPage = Math.min(activePage, pages.length - 1);
  // Cap the rendered dock at SPRINGBOARD_DOCK_LIMIT in BOTH modes. The
  // uncontrolled path already enforces it via toggleFavorite; controlled
  // (desktop-tab) favorites are capped at the pinning source too, but clamp
  // here as defense so the dock can never overflow regardless of caller.
  const favoriteIdList = useMemo(
    () => (favorites ?? layout.favorites).slice(0, SPRINGBOARD_DOCK_LIMIT),
    [favorites, layout.favorites],
  );
  const favoriteEntries = useMemo(
    () =>
      favoriteIdList
        .map((id) => byId.get(id))
        .filter((e): e is ViewEntry => e != null),
    [byId, favoriteIdList],
  );
  // O(1) dock-membership check inside the tile map instead of Array.includes.
  const favoriteSet = useMemo(() => new Set(favoriteIdList), [favoriteIdList]);

  const handleReorder = useCallback(
    (pageIndex: number, nextIds: string[]) => {
      // Rebuild the layout for this page from the reordered id list.
      let next = layout;
      nextIds.forEach((id, index) => {
        next = moveIcon(next, id, pageIndex, index);
      });
      emitViewInteraction({
        source: "springboard",
        action: "reorder",
        count: pageIndex,
      });
      commit(next);
    },
    [layout, commit],
  );

  const renderTile = useCallback(
    (entry: ViewEntry, favorited: boolean) => (
      <IconTile
        entry={entry}
        editing={editing}
        favorited={favorited}
        manageable={canManageView?.(entry.id) ?? false}
        onLaunch={handleLaunch}
        onToggleFavorite={toggleFav}
        onEdit={onEditView}
        onDelete={onDeleteView}
        onLongPress={toggleEditMode}
      />
    ),
    [
      editing,
      canManageView,
      handleLaunch,
      toggleFav,
      onEditView,
      onDeleteView,
      toggleEditMode,
    ],
  );

  const pager = useHorizontalPager({
    page: clampedPage,
    pageCount: pages.length,
    enabled: !editing && pages.length > 1,
    edgeSwipeRightEnabled: showPageDots && onEdgeSwipeRight != null,
    onEdgeSwipeRight,
    onPageChange: (nextPage) => {
      setActivePage(nextPage);
      emitViewInteraction({
        source: "springboard",
        action: "page-swipe",
        count: nextPage,
      });
    },
  });

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-testid="springboard"
    >
      {/* Favorites bar — pinned to the TOP of the springboard (not an iOS-style
          bottom dock). There is no Edit button: long-press any icon toggles
          edit mode (reorder / pin / unpin), and a right-flick leaves it. */}
      {favoriteEntries.length > 0 ? (
        <div
          data-testid="springboard-dock"
          className="mx-3 mt-2 mb-3 flex items-center justify-center gap-3 rounded-3xl border border-white/10 bg-black/45 px-3 py-3 sm:mx-4 sm:gap-4 sm:px-6"
        >
          {favoriteEntries.map((entry) => (
            <div key={`dock-${entry.id}`}>{renderTile(entry, true)}</div>
          ))}
        </div>
      ) : null}

      {/* Swipeable pages. Swipe paging is active only outside edit mode, so it
          never fights the in-tile drag-to-reorder gesture. A real rail is
          rendered so adjacent pages move with the finger, instead of swapping
          page contents after release. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={pager.viewportRef}
          data-testid="springboard-page-window"
          className="relative flex min-h-0 flex-1 overflow-hidden touch-pan-y"
          onPointerDown={pager.handlers.onPointerDown}
          onPointerMove={pager.handlers.onPointerMove}
          onPointerUp={pager.handlers.onPointerUp}
          onPointerCancel={pager.handlers.onPointerCancel}
          onLostPointerCapture={pager.handlers.onLostPointerCapture}
        >
          <div
            ref={pager.railRef}
            data-testid="springboard-page-rail"
            className="flex h-full min-h-0 w-full motion-reduce:transition-none"
          >
            {loading && entries.length === 0 ? (
              <div className="flex h-full min-h-0 min-w-full items-start justify-center overflow-y-auto px-6 pt-2 pb-8">
                <div className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 sm:grid-cols-5">
                  {["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => (
                    <div
                      key={id}
                      className="flex flex-col items-center gap-1.5 opacity-60"
                    >
                      <div className="h-16 w-16 rounded-2xl bg-bg-accent/50" />
                      <div className="h-2.5 w-12 rounded-full bg-bg-accent/50" />
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
                    key={`springboard-page-${pageIndex}`}
                    data-testid={`springboard-page-${pageIndex}`}
                    aria-hidden={!active}
                    inert={!active || undefined}
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
                        className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 sm:grid-cols-5"
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
                              {renderTile(entry, favoriteSet.has(id))}
                            </Reorder.Item>
                          );
                        })}
                      </Reorder.Group>
                    ) : (
                      <div className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 sm:grid-cols-5">
                        {pageIds.map((id) => {
                          const entry = byId.get(id);
                          if (!entry) return null;
                          return (
                            <div key={id} className="flex justify-center">
                              {renderTile(entry, favoriteSet.has(id))}
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

        {/* Page dots — rendered only for STANDALONE usage. When nested in the
            home/springboard rail, `showPageDots` is false and the rail owns the
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
