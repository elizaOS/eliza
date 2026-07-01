/**
 * Launcher layout — persisted icon arrangement for the iOS-like launcher.
 *
 * The catalog renders as a paged home-screen ("launcher"): one or more
 * swipeable pages of uniform view icons. This module owns the pure, persisted
 * layout model (which icon sits on which page, in what order). The
 * rendering/gesture layer consumes these helpers; all reconciliation logic lives
 * here so it is unit testable without a DOM.
 *
 * The `favorites` field is the optional launcher dock. Fresh installs do not
 * seed favorites; every available view flows onto the normal pages until a
 * user explicitly pins an icon.
 *
 * Mirrors the persistence style of `view-recents.ts`.
 */

export const LAUNCHER_STORAGE_KEY = "elizaos.views.launcher";

/**
 * Pre-rename persisted key (#9951, "springboard" → "launcher"). Read once and
 * migrated forward into {@link LAUNCHER_STORAGE_KEY} so an existing user's saved
 * page order / favorites / manual flag survive the rename.
 */
const LEGACY_LAUNCHER_STORAGE_KEY = "elizaos.views.springboard";

/**
 * Icons per launcher page (4 columns × 6 rows, iOS-like). Now that the top
 * double safe-area gap is gone and the page indicator clears the chat composer,
 * a full 6-row page fits a normal phone; smaller phones scroll the grid. The
 * grid is `overflow-y-auto`, so overflow scrolls rather than clipping. The
 * Launcher renders a fixed 4-column grid, so this is `4 × 6 = 24`.
 */
export const LAUNCHER_PAGE_SIZE = 24;
/**
 * Pin cap reused by the desktop-tab pinning model (`useDesktopTabs`). The
 * mobile Launcher and desktop tab rail both cap pinned entries at this
 * iOS-style count.
 */
export const LAUNCHER_DOCK_LIMIT = 4;

export interface LauncherLayout {
  /**
   * Ordered view ids kept out of the page grid and rendered in the dock.
   */
  favorites: string[];
  /** Ordered pages; each page is an ordered list of view ids. */
  pages: string[][];
  /**
   * True once the user has manually reordered icons (drag). Until then the
   * launcher follows the incoming catalog order, so sort-mode changes and
   * newly-installed views reflow naturally; after a manual drag the user's
   * arrangement is preserved.
   */
  manual?: boolean;
}

export function emptyLayout(): LauncherLayout {
  return { favorites: [], pages: [] };
}

/**
 * First-run layout. No favorites are pre-seeded: all entries render in the
 * regular grid, matching the rest of the launcher rows.
 */
export function defaultLayout(): LauncherLayout {
  return emptyLayout();
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function parseLayout(raw: string): LauncherLayout {
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
}

export function readLauncherLayout(): LauncherLayout {
  if (typeof window === "undefined") return emptyLayout();
  try {
    const raw = window.localStorage.getItem(LAUNCHER_STORAGE_KEY);
    if (raw) return parseLayout(raw);
    // One-time migration from the pre-rename "springboard" key (#9951): read the
    // legacy layout, persist it under the new key, and drop the old entry so the
    // user keeps their page order / favorites / manual flag across the rename.
    const legacyRaw = window.localStorage.getItem(LEGACY_LAUNCHER_STORAGE_KEY);
    if (!legacyRaw) return defaultLayout();
    const migrated = parseLayout(legacyRaw);
    writeLauncherLayout(migrated);
    window.localStorage.removeItem(LEGACY_LAUNCHER_STORAGE_KEY);
    return migrated;
  } catch {
    return emptyLayout();
  }
}

export function writeLauncherLayout(layout: LauncherLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* localStorage unavailable */
  }
}

/** All view ids currently placed somewhere in the layout (dock + pages). */
export function placedIds(layout: LauncherLayout): Set<string> {
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
 * - repack pages to LAUNCHER_PAGE_SIZE so removals never leave holes.
 *
 * Deterministic and pure — safe to run on every render.
 */
export function reconcileLayout(
  layout: LauncherLayout,
  availableIds: string[],
  pageSize: number = LAUNCHER_PAGE_SIZE,
): LauncherLayout {
  const available = new Set(availableIds);

  // Dedupe defensively: toggleFavorite never adds a duplicate, but a corrupted
  // or hand-edited localStorage payload could, and a duplicated favorite would
  // otherwise render twice in the dock.
  const favorites = [...new Set(layout.favorites)]
    .filter((id) => available.has(id))
    .slice(0, LAUNCHER_DOCK_LIMIT);
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
  layout: LauncherLayout,
  id: string,
): LauncherLayout {
  if (layout.favorites.includes(id)) {
    return { ...layout, favorites: layout.favorites.filter((f) => f !== id) };
  }
  const favorites = [...layout.favorites, id].slice(-LAUNCHER_DOCK_LIMIT);
  return { ...layout, favorites };
}

/**
 * Move an icon to a target page at a target index, repacking the flattened
 * page order so the move never leaves holes or duplicates. The id is removed
 * from the dock if it was a favorite (an icon lives in exactly one surface).
 *
 * NOTE: cross-page moves (`targetPage > 0`) are fully supported by this model,
 * but the Launcher's current drag gesture is `axis="y"` within the active
 * page only — so cross-page reorder is exercised by tests and available to
 * callers, not by a user gesture today. Do not build cross-page drag UI unless
 * product asks; this capability exists so paging stays correct under repack.
 */
export function moveIcon(
  layout: LauncherLayout,
  id: string,
  targetPage: number,
  targetIndex: number,
  pageSize: number = LAUNCHER_PAGE_SIZE,
): LauncherLayout {
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
