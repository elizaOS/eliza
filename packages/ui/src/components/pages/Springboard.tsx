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
import { animate, motion, Reorder, useMotionValue } from "motion/react";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
/**
 * Horizontal travel must beat vertical by this ratio before the pager claims the
 * gesture — below it the move is a vertical scroll of the tile grid and the
 * carousel stays put, so scrolling a long page never drifts the track sideways.
 */
const PAGER_ANGLE_RATIO = 1.2;
/** Settle animation for the page track when a drag releases (iOS-like ease-out). */
const PAGER_SETTLE_TRANSITION = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.9,
} as const;

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

  // Live carousel paging. The whole paged track (every page side-by-side)
  // follows the finger 1:1 during a horizontal drag (`trackX`), then animates to
  // the committed page on release — an iOS pager, not a half-move-then-snap. The
  // committed resting offset is `-clampedPage * pageWidth`; the drag adds the raw
  // finger delta on top. Vertical scroll is preserved by an axis lock: until a
  // gesture proves horizontal it is left to the per-page `overflow-y-auto`.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState(0);
  const trackX = useMotionValue(0);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    axis: "undecided" | "x" | "y";
  } | null>(null);

  // Measure the viewport so the track translates in real pixels (1:1 with the
  // finger) instead of percentages, which a live drag can't track precisely.
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      if (node) setPageWidth(node.clientWidth);
      return;
    }
    setPageWidth(node.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setPageWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Resting offset for the committed page. While a drag is in flight the pointer
  // handlers own `trackX`; otherwise settle to (or animate toward) the committed
  // page so a page change from the dots / store glides instead of jumping.
  useEffect(() => {
    if (drag.current) return;
    const target = -clampedPage * pageWidth;
    const controls = animate(trackX, target, PAGER_SETTLE_TRANSITION);
    return () => controls.stop();
  }, [clampedPage, pageWidth, trackX]);

  const settleToPage = useCallback(
    (next: number) => {
      const target = -next * pageWidth;
      animate(trackX, target, PAGER_SETTLE_TRANSITION);
    },
    [pageWidth, trackX],
  );

  const handlePagerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (editing || !event.isPrimary || pages.length <= 1) return;
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: -clampedPage * pageWidth,
        axis: "undecided",
      };
    },
    [editing, pages.length, clampedPage, pageWidth],
  );

  const handlePagerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (state.axis === "undecided") {
        if (Math.hypot(dx, dy) < LONG_PRESS_MOVE_SLOP) return;
        // Lock to whichever axis the finger committed to first: horizontal pans
        // the carousel; vertical yields to the per-page scroll and never drifts
        // the track sideways.
        state.axis =
          Math.abs(dx) > Math.abs(dy) * PAGER_ANGLE_RATIO ? "x" : "y";
        if (state.axis === "y") {
          drag.current = null;
          return;
        }
        // Capture so the drag keeps tracking even if the finger slides off the
        // viewport. Guarded: not every environment implements pointer capture.
        event.currentTarget.setPointerCapture?.(state.pointerId);
      }
      if (state.axis !== "x") return;
      // Resist past the first / last page so the edge has the same rubber-band
      // give as an iOS pager rather than tearing off into empty space.
      const atStart = clampedPage === 0 && dx > 0;
      const atEnd = clampedPage === pages.length - 1 && dx < 0;
      const applied = atStart || atEnd ? dx * 0.3 : dx;
      trackX.set(state.baseX + applied);
    },
    [clampedPage, pages.length, trackX],
  );

  const finishPagerDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      drag.current = null;
      if (state.axis !== "x") return;
      const dx = event.clientX - state.startX;
      if (dx < -SWIPE_THRESHOLD && clampedPage < pages.length - 1) {
        const next = clampedPage + 1;
        settleToPage(next);
        setActivePage(next);
        emitViewInteraction({
          source: "springboard",
          action: "page-swipe",
          count: next,
        });
      } else if (dx > SWIPE_THRESHOLD && clampedPage > 0) {
        const next = clampedPage - 1;
        settleToPage(next);
        setActivePage(next);
        emitViewInteraction({
          source: "springboard",
          action: "page-swipe",
          count: next,
        });
      } else {
        // Under threshold (or edge-bounce): glide back to the current page.
        settleToPage(clampedPage);
        if (dx > SWIPE_THRESHOLD && clampedPage === 0) onEdgeSwipeRight?.();
      }
    },
    [clampedPage, pages.length, settleToPage, setActivePage, onEdgeSwipeRight],
  );

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-testid="springboard"
    >
      {/* Carousel viewport. The track holds every page side-by-side and the
          pointer handlers translate it 1:1 with the finger (`trackX`), settling
          to the committed page on release. Paging is active only outside edit
          mode, so it never fights the in-tile drag-to-reorder gesture. */}
      <div
        ref={viewportRef}
        // `touch-pan-y`: hand vertical drags to the browser (the per-page grid
        // scrolls) and claim horizontal drags for the carousel. The axis lock in
        // the move handler makes this precise even where touch-action isn't
        // honored (desktop pointer / tests).
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden touch-pan-y"
        onPointerDown={handlePagerPointerDown}
        onPointerMove={handlePagerPointerMove}
        onPointerUp={finishPagerDrag}
        onPointerCancel={finishPagerDrag}
        data-testid="springboard-pager-viewport"
      >
        {loading && entries.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pt-2 pb-8">
            <div className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5">
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
          <motion.div
            data-testid="springboard-pager-track"
            // The whole multi-page track translates as one element: a stable
            // identity (no `key={clampedPage}`) keeps Reorder.Group + every tile
            // mounted across swipes, so paging never janks via remount (#9304).
            // Each page is exactly the measured viewport width, so the pixel
            // translate (`trackX`) tracks the finger 1:1.
            className="flex min-h-0 flex-1 items-stretch"
            style={{ x: trackX }}
          >
            {pages.map((pageIds, pageIndex) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: pages have no stable id; index is the page identity.
                key={`page-${pageIndex}-${pageIds[0] ?? "empty"}`}
                data-testid={`springboard-page-${pageIndex}`}
                // Off-screen pages are hidden from AT/tab order; only the
                // committed page is reachable, even though every page stays
                // mounted in the carousel track.
                aria-hidden={pageIndex !== clampedPage}
                className="flex min-h-0 shrink-0 items-start justify-center overflow-y-auto px-6 pt-2 pb-8"
                style={pageWidth > 0 ? { width: pageWidth } : { width: "100%" }}
              >
                <Reorder.Group
                  axis="y"
                  values={pageIds}
                  onReorder={(next) =>
                    handleReorder(pageIndex, next as string[])
                  }
                  className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-5"
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
              </div>
            ))}
          </motion.div>
        )}

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
