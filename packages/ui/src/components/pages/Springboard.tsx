/**
 * Springboard — iOS-like home-screen view catalog.
 *
 * Renders every available view as a names-only icon on swipeable pages plus a
 * pinned favorites dock. Tap launches; the Edit toggle (or long-press) enters
 * edit mode where icons can be reordered (drag), favorited into the dock, and —
 * for manageable (dynamic developer) views — edited or deleted. Page order is
 * persisted via the pure `springboard-layout` model. Favorites are
 * controlled-optional: when `onToggleFavorite` is supplied the dock reflects the
 * caller's `favoriteIds` (the app wires this to desktop tabs, so favoriting a
 * view pins it as a tab); otherwise favorites are kept locally. Fully
 * token-themed (light/dark + overrides) and renders no background of its own —
 * the shared root `AppBackground` shows through, matching the home screen.
 */

import { Pencil, Trash2 } from "lucide-react";
import { motion, Reorder } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ViewIcon } from "../views/ViewIcon";

export interface SpringboardProps {
  entries: ViewEntry[];
  onLaunch: (entry: ViewEntry) => void;
  /** When set, favorites are controlled by the caller (e.g. desktop tabs). */
  favoriteIds?: string[];
  onToggleFavorite?: (id: string) => void;
  /** Per-tile management for dynamic views, shown in edit mode when allowed. */
  canManageView?: (id: string) => boolean;
  onEditView?: (id: string) => void;
  onDeleteView?: (id: string) => void;
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
/** Horizontal drag distance (px) needed to flip to the adjacent page. */
const SWIPE_THRESHOLD = 60;

function IconTile({
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
  // Every view shows its hero image (the endpoint returns a real image or a
  // branded generated SVG). Fall back to the Lucide icon only if the image fails
  // to load, so a tile is never blank.
  const [imgFailed, setImgFailed] = useState(false);
  const tileImage = imgFailed ? undefined : entry.imageUrl;

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
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
          onPointerDown={() => {
            clear();
            timer.current = setTimeout(onLongPress, LONG_PRESS_MS);
          }}
          onPointerUp={clear}
          onPointerLeave={clear}
          // pointercancel (not pointerup) fires when a touch scroll or system
          // gesture interrupts the press — clear the timer so a long-press never
          // ghost-fires edit mode after the user finishes scrolling.
          onPointerCancel={clear}
          className={cn(
            "h-16 w-16 overflow-hidden rounded-2xl transition-colors",
            "  ",
            tileImage
              ? "bg-bg-accent/40"
              : "grid place-items-center bg-bg-accent/60 text-foreground hover:bg-bg-accent",
            editing && "animate-pulse",
          )}
        >
          {tileImage ? (
            <img
              src={tileImage}
              alt=""
              draggable={false}
              onError={() => setImgFailed(true)}
              className="h-full w-full object-cover"
              data-testid={`springboard-image-${entry.id}`}
            />
          ) : (
            <ViewIcon
              icon={entry.icon}
              label={entry.label}
              id={entry.id}
              className="h-7 w-7"
            />
          )}
        </button>
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
              "absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold",
              favorited
                ? "bg-accent text-accent-foreground"
                : "bg-border text-foreground",
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
      <span className="max-w-[4.5rem] truncate text-center text-[11px] leading-tight text-muted">
        {entry.label}
      </span>
    </div>
  );
}

export function Springboard({
  entries,
  onLaunch,
  favoriteIds,
  onToggleFavorite,
  canManageView,
  onEditView,
  onDeleteView,
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
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);

  // Re-reconcile when the available views or controlled favorites change.
  useEffect(() => {
    setLayout((prev) =>
      reconcileLayout(
        { favorites: favorites ?? prev.favorites, pages: prev.pages },
        availableIds,
      ),
    );
  }, [availableIds, favorites]);

  // Keep the active page index in range when pages shrink (views removed), so
  // stale page state can't leak into later logic. clampedPage masks it for
  // render, but the underlying `page` is reset here.
  useEffect(() => {
    const pageCount = layout.pages.length > 0 ? layout.pages.length : 1;
    setPage((p) => (p > pageCount - 1 ? pageCount - 1 : p));
  }, [layout.pages.length]);

  const commit = useCallback((next: SpringboardLayout) => {
    setLayout(next);
    writeSpringboardLayout(next);
  }, []);

  const toggleFav = useCallback(
    (id: string) => {
      if (controlled) {
        onToggleFavorite?.(id);
        return;
      }
      commit(reconcileLayout(toggleFavorite(layout, id), availableIds));
    },
    [controlled, onToggleFavorite, commit, layout, availableIds],
  );

  const pages = layout.pages.length > 0 ? layout.pages : [[]];
  const clampedPage = Math.min(page, pages.length - 1);
  // Cap the rendered dock at SPRINGBOARD_DOCK_LIMIT in BOTH modes. The
  // uncontrolled path already enforces it via toggleFavorite; controlled
  // (desktop-tab) favorites are capped at the pinning source too, but clamp
  // here as defense so the dock can never overflow regardless of caller.
  const favoriteIdList = (favorites ?? layout.favorites).slice(
    0,
    SPRINGBOARD_DOCK_LIMIT,
  );
  const favoriteEntries = favoriteIdList
    .map((id) => byId.get(id))
    .filter((e): e is ViewEntry => e != null);

  const handleReorder = useCallback(
    (pageIndex: number, nextIds: string[]) => {
      // Rebuild the layout for this page from the reordered id list.
      let next = layout;
      nextIds.forEach((id, index) => {
        next = moveIcon(next, id, pageIndex, index);
      });
      commit(next);
    },
    [layout, commit],
  );

  const renderTile = (entry: ViewEntry, favorited: boolean) => (
    <IconTile
      entry={entry}
      editing={editing}
      favorited={favorited}
      manageable={canManageView?.(entry.id) ?? false}
      onLaunch={onLaunch}
      onToggleFavorite={toggleFav}
      onEdit={onEditView}
      onDelete={onDeleteView}
      onLongPress={() => setEditing(true)}
    />
  );

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-testid="springboard"
    >
      <div className="flex items-center justify-end px-4 pt-2">
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-medium transition-colors",
            editing
              ? "bg-accent text-accent-foreground"
              : "bg-bg-accent/60 text-muted hover:bg-bg-accent",
          )}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>

      {/* Swipeable pages. Swipe paging is active only outside edit mode, so it
          never fights the in-tile drag-to-reorder gesture. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <motion.div
          key={clampedPage}
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
              setPage(clampedPage + 1);
            } else if (info.offset.x > SWIPE_THRESHOLD && clampedPage > 0) {
              setPage(clampedPage - 1);
            }
          }}
          className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 py-6"
        >
          <Reorder.Group
            axis="y"
            values={pages[clampedPage] ?? []}
            onReorder={(next) => handleReorder(clampedPage, next as string[])}
            className="grid w-full max-w-2xl grid-cols-4 gap-x-4 gap-y-6 sm:grid-cols-5"
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
                  {renderTile(entry, favoriteIdList.includes(id))}
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        </motion.div>

        {/* Page dots. */}
        {pages.length > 1 ? (
          <div className="flex items-center justify-center gap-2 pb-3">
            {pages.map((pageIds, index) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: pages have no stable id; index is the page identity.
                key={`dot-${index}-${pageIds[0] ?? "empty"}`}
                type="button"
                aria-label={`Page ${index + 1}`}
                aria-current={index === clampedPage}
                onClick={() => setPage(index)}
                className={cn(
                  "h-2 w-2 rounded-full transition-colors",
                  index === clampedPage ? "bg-accent" : "bg-border",
                )}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Favorites dock. */}
      {favoriteEntries.length > 0 ? (
        <div
          data-testid="springboard-dock"
          className="mx-4 mb-4 flex items-center justify-center gap-4 rounded-3xl bg-bg-accent/90 px-6 py-3"
        >
          {favoriteEntries.map((entry) => (
            <div key={`dock-${entry.id}`}>{renderTile(entry, true)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
