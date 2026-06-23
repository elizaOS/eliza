/**
 * Springboard layout — persisted icon arrangement for the iOS-like view catalog.
 *
 * The catalog renders as a paged home-screen ("springboard"): a fixed dock of
 * favorites plus one or more swipeable pages of view icons. This module owns the
 * pure, persisted layout model (which icon sits on which page, in what order,
 * and which icons are favorited into the dock). The rendering/gesture layer
 * consumes these helpers; all reconciliation logic lives here so it is unit
 * testable without a DOM.
 *
 * Mirrors the persistence style of `view-recents.ts`.
 */

export const SPRINGBOARD_STORAGE_KEY = "elizaos.views.springboard";

/** Icons per springboard page (4 columns × 5 rows, iOS-like). */
export const SPRINGBOARD_PAGE_SIZE = 20;
/** Maximum icons pinned to the dock (favorites). */
export const SPRINGBOARD_DOCK_LIMIT = 4;

export interface SpringboardLayout {
  /** Ordered view ids pinned to the dock. Capped at SPRINGBOARD_DOCK_LIMIT. */
  favorites: string[];
  /** Ordered pages; each page is an ordered list of view ids. */
  pages: string[][];
  /**
   * True once the user has manually reordered icons (drag). Until then the
   * springboard follows the incoming catalog order, so sort-mode changes and
   * newly-installed views reflow naturally; after a manual drag the user's
   * arrangement is preserved.
   */
  manual?: boolean;
}

export function emptyLayout(): SpringboardLayout {
  return { favorites: [], pages: [] };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function readSpringboardLayout(): SpringboardLayout {
  if (typeof window === "undefined") return emptyLayout();
  try {
    const raw = window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY);
    if (!raw) return emptyLayout();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyLayout();
    const record = parsed as Record<string, unknown>;
    const favorites = isStringArray(record.favorites) ? record.favorites : [];
    const pages =
      Array.isArray(record.pages) && record.pages.every(isStringArray)
        ? (record.pages as string[][])
        : [];
    const manual = record.manual === true ? true : undefined;
    return { favorites, pages, manual };
  } catch {
    return emptyLayout();
  }
}

export function writeSpringboardLayout(layout: SpringboardLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SPRINGBOARD_STORAGE_KEY,
      JSON.stringify(layout),
    );
  } catch {
    /* localStorage unavailable */
  }
}

/** All view ids currently placed somewhere in the layout (dock + pages). */
export function placedIds(layout: SpringboardLayout): Set<string> {
  const ids = new Set<string>(layout.favorites);
  for (const page of layout.pages) {
    for (const id of page) ids.add(id);
  }
  return ids;
}

function chunk(ids: string[], size: number): string[][] {
  if (ids.length === 0) return [];
  const pages: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    pages.push(ids.slice(i, i + size));
  }
  return pages;
}

/**
 * Reconcile a stored layout against the live set of available view ids:
 * - drop ids that no longer exist (uninstalled / hidden views),
 * - append newly-available ids (preserving their catalog order) to the end,
 * - keep dock favorites out of the page grid (the dock is a separate surface),
 * - repack pages to SPRINGBOARD_PAGE_SIZE so removals never leave holes.
 *
 * Deterministic and pure — safe to run on every render.
 */
export function reconcileLayout(
  layout: SpringboardLayout,
  availableIds: string[],
  pageSize: number = SPRINGBOARD_PAGE_SIZE,
): SpringboardLayout {
  const available = new Set(availableIds);

  const favorites = layout.favorites
    .filter((id) => available.has(id))
    .slice(0, SPRINGBOARD_DOCK_LIMIT);
  const favoriteSet = new Set(favorites);

  const seen = new Set<string>(favorites);
  const ordered: string[] = [];
  // A manually-arranged layout preserves the user's page ordering first; an
  // automatic one follows the incoming catalog order so sort/install reflows.
  if (layout.manual) {
    for (const page of layout.pages) {
      for (const id of page) {
        if (available.has(id) && !favoriteSet.has(id) && !seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }
  }
  // Append remaining available ids in catalog order (all of them when auto).
  for (const id of availableIds) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  return { favorites, pages: chunk(ordered, pageSize), manual: layout.manual };
}

/** Toggle an id in/out of the dock. Adding evicts the oldest when full. */
export function toggleFavorite(
  layout: SpringboardLayout,
  id: string,
): SpringboardLayout {
  if (layout.favorites.includes(id)) {
    return { ...layout, favorites: layout.favorites.filter((f) => f !== id) };
  }
  const favorites = [...layout.favorites, id].slice(-SPRINGBOARD_DOCK_LIMIT);
  return { ...layout, favorites };
}

/**
 * Move an icon to a target page at a target index, repacking the flattened
 * page order so the move never leaves holes or duplicates. The id is removed
 * from the dock if it was a favorite (an icon lives in exactly one surface).
 */
export function moveIcon(
  layout: SpringboardLayout,
  id: string,
  targetPage: number,
  targetIndex: number,
  pageSize: number = SPRINGBOARD_PAGE_SIZE,
): SpringboardLayout {
  const favorites = layout.favorites.filter((f) => f !== id);
  const pages = layout.pages.map((page) => page.filter((p) => p !== id));
  while (pages.length <= targetPage) pages.push([]);
  const page = pages[targetPage];
  const index = Math.max(0, Math.min(targetIndex, page.length));
  page.splice(index, 0, id);
  const flat = pages.flat();
  // A drag is an explicit manual arrangement — lock the order from now on.
  return { favorites, pages: chunk(flat, pageSize), manual: true };
}
