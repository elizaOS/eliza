/**
 * Springboard — iOS-like home-screen view catalog.
 *
 * Renders every available view as a names-only icon on swipeable pages plus a
 * pinned favorites dock. Tap launches; long-press (or the Edit toggle) enters
 * edit mode where icons can be reordered (drag) and favorited into the dock.
 * Layout is persisted via the pure `springboard-layout` model. The component is
 * fully token-themed, so it tracks light/dark and theme overrides automatically,
 * and it renders no background of its own — the shared root `AppBackground`
 * shows through, matching the home screen.
 */

import { Reorder } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import {
  moveIcon,
  readSpringboardLayout,
  reconcileLayout,
  type SpringboardLayout,
  toggleFavorite,
  writeSpringboardLayout,
} from "../../state/springboard-layout";
import { ViewIcon } from "../views/ViewIcon";

export interface SpringboardProps {
  entries: ViewEntry[];
  onLaunch: (entry: ViewEntry) => void;
  className?: string;
}

interface IconTileProps {
  entry: ViewEntry;
  editing: boolean;
  favorited: boolean;
  onLaunch: (entry: ViewEntry) => void;
  onToggleFavorite: (id: string) => void;
  onLongPress: () => void;
}

const LONG_PRESS_MS = 450;

function IconTile({
  entry,
  editing,
  favorited,
  onLaunch,
  onToggleFavorite,
  onLongPress,
}: IconTileProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          className={cn(
            "grid h-16 w-16 place-items-center rounded-2xl",
            "bg-bg-accent/60 text-foreground backdrop-blur-xl transition-colors",
            "hover:bg-bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
            editing && "animate-pulse",
          )}
        >
          <ViewIcon
            icon={entry.icon}
            label={entry.label}
            id={entry.id}
            className="h-7 w-7"
          />
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
  className,
}: SpringboardProps) {
  const availableIds = useMemo(() => entries.map((e) => e.id), [entries]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const [layout, setLayout] = useState<SpringboardLayout>(() =>
    reconcileLayout(
      readSpringboardLayout(),
      entries.map((e) => e.id),
    ),
  );
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);

  // Re-reconcile whenever the available views change (install/uninstall/gating).
  useEffect(() => {
    setLayout((prev) => reconcileLayout(prev, availableIds));
  }, [availableIds]);

  const commit = useCallback((next: SpringboardLayout) => {
    setLayout(next);
    writeSpringboardLayout(next);
  }, []);

  const pages = layout.pages.length > 0 ? layout.pages : [[]];
  const clampedPage = Math.min(page, pages.length - 1);
  const favoriteEntries = layout.favorites
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

      {/* Swipeable pages. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 py-6">
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
                  <IconTile
                    entry={entry}
                    editing={editing}
                    favorited={layout.favorites.includes(id)}
                    onLaunch={onLaunch}
                    onToggleFavorite={(fid) =>
                      commit(
                        reconcileLayout(
                          toggleFavorite(layout, fid),
                          availableIds,
                        ),
                      )
                    }
                    onLongPress={() => setEditing(true)}
                  />
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        </div>

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
        <div className="mx-4 mb-4 flex items-center justify-center gap-4 rounded-3xl bg-bg-accent/60 px-6 py-3 backdrop-blur-2xl">
          {favoriteEntries.map((entry) => (
            <IconTile
              key={`dock-${entry.id}`}
              entry={entry}
              editing={editing}
              favorited
              onLaunch={onLaunch}
              onToggleFavorite={(fid) =>
                commit(
                  reconcileLayout(toggleFavorite(layout, fid), availableIds),
                )
              }
              onLongPress={() => setEditing(true)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
