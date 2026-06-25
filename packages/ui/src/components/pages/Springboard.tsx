/**
 * Springboard — iOS-like app/view launcher.
 *
 * Renders every available view as a single uniform, NAKED tile on swipeable
 * pages: a real branded hero image when one loads, otherwise the view glyph
 * sitting directly on the ambient orange field (no dark card, no border). Every
 * tile looks the same. Tap launches; long-press enters edit mode where icons can
 * be reordered (drag) and — for manageable (dynamic developer) views — edited or
 * deleted. Page order is persisted via the pure `springboard-layout` model.
 * Renders no background of its own — the shared root `AppBackground` shows
 * through, matching the home screen.
 *
 * The `favoriteIds` / `onToggleFavorite` props are retained for the desktop-tab
 * caller's type compatibility but are no longer rendered: there is no favorites
 * dock, so every tile is identical.
 */

import { Pencil, Trash2 } from "lucide-react";
import { motion, Reorder } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import {
  moveIcon,
  readSpringboardLayout,
  reconcileLayout,
  type SpringboardLayout,
  writeSpringboardLayout,
} from "../../state/springboard-layout";
import { emitViewInteraction } from "../../view-telemetry";
import { ViewTileImage } from "../views/ViewTileImage";

export interface SpringboardProps {
  entries: ViewEntry[];
  loading?: boolean;
  onLaunch: (entry: ViewEntry) => void;
  onEdgeSwipeRight?: () => void;
  /**
   * Retained for desktop-tab caller type compatibility. The favorites dock was
   * removed, so these are accepted and ignored — every tile renders uniformly.
   */
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
/** Horizontal drag distance (px) needed to flip to the adjacent page. */
const SWIPE_THRESHOLD = 60;

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
            // NAKED tile: no card, no border. ViewTileImage handles
            // image-vs-glyph internally. The hero image (object-cover) IS the
            // tile when it loads; otherwise the white glyph (with a soft shadow,
            // applied in ViewTileImage's glyphClassName) sits directly on the
            // ambient orange field. Hover is a faint white wash (never
            // orange→black). Filter effects (#9281) and focus rings (#9292) were
            // removed on develop.
            "h-16 w-16 overflow-hidden rounded-2xl text-white transition-colors hover:bg-white/8",
            editing && "animate-pulse",
          )}
        >
          <ViewTileImage
            entry={entry}
            source="springboard"
            containerClassName="grid h-full w-full place-items-center"
            glyphClassName="h-7 w-7 text-white [filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.38))]"
            imageTestId={`springboard-image-${entry.id}`}
          />
        </button>
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
      <span className="max-w-[4.5rem] truncate text-center text-[11px] font-medium leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.38)]">
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
  // favoriteIds / onToggleFavorite are accepted for desktop-tab type
  // compatibility but intentionally unused — the favorites dock was removed.
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

  const [layout, setLayout] = useState<SpringboardLayout>(() => {
    const stored = readSpringboardLayout();
    // The favorites dock is gone — drop any favorites a prior version persisted
    // so those views reappear as ordinary page tiles instead of vanishing
    // (reconcileLayout keeps favorites OUT of the page grid).
    return reconcileLayout(
      { ...stored, favorites: [] },
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

  // Re-reconcile when the available views change.
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

  const commit = useCallback((next: SpringboardLayout) => {
    setLayout(next);
    writeSpringboardLayout(next);
  }, []);

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

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-testid="springboard"
    >
      {/* Swipeable pages. Swipe paging is active only outside edit mode, so it
          never fights the in-tile drag-to-reorder gesture. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <motion.div
          // A stable identity (NOT `key={clampedPage}`): keying on the page
          // index forced a full unmount/remount of the page — Reorder.Group and
          // every tile — on each swipe, which janks the paging. The page content
          // already swaps via `pages[clampedPage]`, and `dragSnapToOrigin`
          // animates the drag back to origin, so the swap is smooth without a
          // remount (#9304).
          key="springboard-page"
          drag={editing ? false : "x"}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.2}
          dragSnapToOrigin
          onDragEnd={(_event, info) => {
            if (editing) return;
            if (
              info.offset.x < -SWIPE_THRESHOLD &&
              clampedPage < pages.length - 1
            ) {
              setActivePage(clampedPage + 1);
              emitViewInteraction({
                source: "springboard",
                action: "page-swipe",
                count: clampedPage + 1,
              });
            } else if (info.offset.x > SWIPE_THRESHOLD && clampedPage > 0) {
              setActivePage(clampedPage - 1);
              emitViewInteraction({
                source: "springboard",
                action: "page-swipe",
                count: clampedPage - 1,
              });
            } else if (info.offset.x > SWIPE_THRESHOLD && clampedPage === 0) {
              onEdgeSwipeRight?.();
            }
          }}
          className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pt-2 pb-8"
        >
          {loading && entries.length === 0 ? (
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
          ) : (
            <Reorder.Group
              axis="y"
              values={pages[clampedPage] ?? []}
              onReorder={(next) => handleReorder(clampedPage, next as string[])}
              className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5 sm:grid-cols-5"
            >
              {(pages[clampedPage] ?? []).map((id) => {
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
          )}
        </motion.div>

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
