/**
 * Launcher layout — persisted icon arrangement for the iOS-like launcher.
 *
 * The catalog renders as a paged home-screen ("launcher"): one or more
 * swipeable pages of uniform view icons. This module owns the pure, persisted
 * layout model (which icon sits on which page, in what order). The
 * rendering/gesture layer consumes these helpers; all reconciliation logic lives
 * here so it is unit testable without a DOM.
 *
 * The launcher has no dock / favorites surface — every available view lives on
 * the swipeable pages. (The removed dock was the "featured views" header;
 * `LAUNCHER_DOCK_LIMIT` is retained only because the desktop-tab pinning model
 * reuses it — it no longer governs a mobile dock.)
 *
 * Mirrors the persistence style of `view-recents.ts`.
 */

export const LAUNCHER_STORAGE_KEY = "elizaos.views.launcher";

/**
 * Pre-rename persisted key (#9951, "springboard" → "launcher"). Read once and
 * migrated forward into {@link LAUNCHER_STORAGE_KEY} so an existing user's saved
 * page order / manual flag survive the rename.
 */
const LEGACY_LAUNCHER_STORAGE_KEY = "elizaos.views.springboard";

/**
 * Icons per launcher page. The Launcher grid is responsive — `grid-cols-4`
 * (portrait/mobile) and `sm:grid-cols-5` at ≥sm — and is `overflow-y-auto`, so a
 * page that exceeds the visible rows scrolls rather than clipping. 24 gives exact
 * 4×6 pages on mobile; at ≥sm it fills 4 rows of 5 plus a 4-tile final row.
 */
export const LAUNCHER_PAGE_SIZE = 24;
/**
 * Pin cap for the desktop-tab pinning model (`useDesktopTabs`). Retained here as
 * the shared iOS-style cap; the mobile launcher no longer has a dock.
 */
export const LAUNCHER_DOCK_LIMIT = 4;

export interface LauncherLayout {
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
  return { pages: [] };
}

/**
 * First-run layout. Reconciliation fills the pages from the live view ids, so a
 * fresh install simply lays every available view out in catalog order.
 */
export function defaultLayout(): LauncherLayout {
  return { pages: [] };
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
  const pages =
    Array.isArray(record.pages) && record.pages.every(isStringArray)
      ? (record.pages as string[][])
      : [];
  const manual = record.manual === true ? true : undefined;
  return { pages, manual };
}

export function readLauncherLayout(): LauncherLayout {
  if (typeof window === "undefined") return emptyLayout();
  try {
    const raw = window.localStorage.getItem(LAUNCHER_STORAGE_KEY);
    if (raw) return parseLayout(raw);
    // One-time migration from the pre-rename "springboard" key (#9951): read the
    // legacy layout, persist it under the new key, and drop the old entry so the
    // user keeps their page order / manual flag across the rename.
    const legacyRaw = window.localStorage.getItem(LEGACY_LAUNCHER_STORAGE_KEY);
    if (!legacyRaw) return defaultLayout();
    const migrated = parseLayout(legacyRaw);
    writeLauncherLayout(migrated);
    window.localStorage.removeItem(LEGACY_LAUNCHER_STORAGE_KEY);
    return migrated;
  } catch {
    return defaultLayout();
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

/** All view ids currently placed somewhere in the layout. */
export function placedIds(layout: LauncherLayout): Set<string> {
  const ids = new Set<string>();
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
  const seen = new Set<string>();
  const ordered: string[] = [];
  // A manually-arranged layout preserves the user's page ordering first; an
  // automatic one follows the incoming catalog order so sort/install reflows.
  if (layout.manual) {
    for (const page of layout.pages) {
      for (const id of page) {
        if (available.has(id) && !seen.has(id)) {
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

  return { pages: chunk(ordered, pageSize), manual: layout.manual };
}

/**
 * Move an icon to a target page at a target index, repacking the flattened
 * page order so the move never leaves holes or duplicates.
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
  const pages = layout.pages.map((page) => page.filter((p) => p !== id));
  while (pages.length <= targetPage) pages.push([]);
  const page = pages[targetPage];
  const index = Math.max(0, Math.min(targetIndex, page.length));
  page.splice(index, 0, id);
  const flat = pages.flat();
  // A drag is an explicit manual arrangement — lock the order from now on.
  return { pages: chunk(flat, pageSize), manual: true };
}
