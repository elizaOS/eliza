/** Photos view rules (design/view-refresh-2026-11 section 2, specs/photos-library Design.cfg).
 * Dependency-free so test/photos-view.test.mjs runs them in node. */

export type ViewRow = {
  id: string;
  date: number;
  taken?: number;
  kind?: string;
  favorite?: boolean;
  trashed?: boolean;
  folder?: string;
  width?: number;
  height?: number;
  mutationRevision?: string;
  revision?: string;
  expiresAt?: number;
};
const DAY = 86400000;
const startOfDay = (time: number) => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** The capture time shown and grouped on: DATE_TAKEN when the provider has it, else the added date. */
export const shotAt = (row: { date: number; taken?: number }) =>
  row.taken && row.taken > 0 ? row.taken : row.date;

/** Days within this many days of today get their own header; older items group by month. */
export const DAY_HEADER_WINDOW = 30;
/** "Today", "Yesterday", "Sat, Oct 31" (with the year when it differs), then "October 2026". */
export function sectionKey(
  time: number,
  now = Date.now(),
): { key: string; label: string } {
  const ago = Math.round((startOfDay(now) - startOfDay(time)) / DAY),
    d = new Date(time);
  if (ago <= 0) return { key: "today", label: "Today" };
  if (ago === 1) return { key: "yesterday", label: "Yesterday" };
  if (ago < DAY_HEADER_WINDOW) {
    const year = d.getFullYear() !== new Date(now).getFullYear();
    return {
      key: `d:${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
      label: d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(year ? { year: "numeric" } : {}),
      }),
    };
  }
  return {
    key: `m:${d.getFullYear()}-${d.getMonth()}`,
    label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

/** Newest first by capture time; equal times keep a stable identity order, so paging never reorders. */
export function newestFirst<T extends ViewRow>(rows: readonly T[]): T[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        shotAt(b) - shotAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
}

/** Consecutive rows that share a section, in the order given (callers pass newestFirst rows). */
export function groupSections<T extends ViewRow>(
  rows: readonly T[],
  now = Date.now(),
): { key: string; label: string; items: T[] }[] {
  const groups: { key: string; label: string; items: T[] }[] = [];
  for (const row of rows) {
    const section = sectionKey(shotAt(row), now),
      last = groups[groups.length - 1];
    if (last && last.key === section.key) last.items.push(row);
    else groups.push({ ...section, items: [row] });
  }
  return groups;
}

/** The loaded window keeps the newest `limit` rows (NewestNeverDropped); merging a page never reorders kept rows. */
export function mergeWindow<T extends ViewRow>(
  kept: readonly T[],
  page: readonly T[],
  limit: number,
): T[] {
  const byId = new Map<string, T>();
  for (const row of kept) byId.set(row.id, row);
  for (const row of page) byId.set(row.id, row);
  return newestFirst([...byId.values()]).slice(0, Math.max(0, limit));
}

/** Reads the library window. Paging (`more`) reads one page after `cursor`; a reload re-reads from the
 * top as many rows as were loaded (bounded by `limit`), so a row the owner scrolled to, selected or
 * opened is still in the window after an unrelated library change (FixPatch). */
export async function readWindow<T extends ViewRow>(
  list: (options: {
    before?: string;
    thumbnails?: boolean;
  }) => Promise<{ items: T[]; next: string }>,
  options: { more: boolean; cursor: string; loaded: number; limit: number },
  current: () => boolean = () => true,
): Promise<{ rows: T[]; next: string } | undefined> {
  const want = options.more
      ? 1
      : Math.min(Math.max(options.loaded, 1), options.limit),
    rows: T[] = [];
  let cursor = options.more ? options.cursor : "";
  const visited = new Set<string>();
  do {
    if (visited.has(cursor))
      throw new Error("Photo library pagination repeated a cursor");
    visited.add(cursor);
    const result = await list({
      ...(cursor ? { before: cursor } : {}),
      ...(options.more || !rows.length ? {} : { thumbnails: false }),
    });
    if (!current()) return undefined;
    rows.push(...result.items);
    cursor = result.next;
  } while (cursor && !options.more && rows.length < want);
  return { rows, next: cursor };
}

/** Reuse pixels only when every content revision still matches the reloaded row. */
export function keepThumbnails<
  T extends ViewRow & { image?: string; contentRevision?: string },
>(rows: readonly T[], before: readonly T[]): T[] {
  const held = new Map(
    before.filter((row) => row.image).map((row) => [row.id, row] as const),
  );
  return rows.map((row) => {
    const old = held.get(row.id);
    return !row.image &&
      old &&
      old.revision === row.revision &&
      old.mutationRevision === row.mutationRevision &&
      old.contentRevision === row.contentRevision
      ? { ...row, image: old.image }
      : row;
  });
}

/** Replace changed rows in place; a row that left this list (trashed/restored/deleted) is removed. Never reorders. */
export function patchRows<T extends ViewRow>(
  rows: readonly T[],
  changed: readonly T[],
  keep: (row: T) => boolean,
): T[] {
  const byId = new Map(changed.map((row) => [row.id, row] as const));
  return rows
    .map((row) => (byId.has(row.id) ? { ...row, ...byId.get(row.id)! } : row))
    .filter(keep);
}
/** Insert rows that now belong to a list (a restore, an undo) at their date position, not at the top. */
export function insertRows<T extends ViewRow>(
  rows: readonly T[],
  added: readonly T[],
): T[] {
  const ids = new Set(added.map((row) => row.id));
  return newestFirst([...rows.filter((row) => !ids.has(row.id)), ...added]);
}

/** External MediaStore change: keep the selection to rows that still exist in the visible pool, with
 * their current revision; close the viewer only when its item no longer exists (FixPatch). */
export function patchSelection<T extends ViewRow>(
  selection: readonly T[] | undefined,
  pool: readonly T[],
): T[] | undefined {
  if (!selection) return undefined;
  const live = new Map(pool.map((row) => [row.id, row] as const));
  return selection
    .filter((row) => live.has(row.id))
    .map((row) => live.get(row.id)!);
}
export function viewerSurvives(
  open: string | null | undefined,
  pool: readonly ViewRow[],
  exists?: (id: string) => boolean,
): boolean {
  if (!open) return true;
  return pool.some((row) => row.id === open) || !!exists?.(open);
}

/** Batch Favorite toggles: every selected item favourite → unfavourite them all, otherwise favourite (FixFavToggle). */
export function favoriteTarget(
  rows: readonly { favorite?: boolean }[],
): boolean {
  return !rows.length || !rows.every((row) => row.favorite);
}

/** Large selections are split into native-sized batches; the person never sees a cap (FixNoCap). */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += Math.max(1, size))
    out.push(items.slice(at, at + Math.max(1, size)));
  return out;
}

/** Which loaded rows hold a thumbnail: at most `keep` rows around the rendered range [from, to) of
 * `rows` keep (or fetch again) their image; every other row drops it, so a long scroll does not hold
 * thousands of thumbnail strings. Returns the ids to drop and the ids to fetch, in row order. */
export function thumbnailPlan<T extends ViewRow & { image?: string }>(
  rows: readonly T[],
  from: number,
  to: number,
  keep: number,
): { drop: string[]; fetch: string[] } {
  const start = Math.max(0, Math.min(from, rows.length)),
    end = Math.max(start, Math.min(to, rows.length));
  const margin = Math.max(
    0,
    Math.floor((Math.max(keep, end - start) - (end - start)) / 2),
  );
  const low = Math.max(0, start - margin),
    high = Math.min(rows.length, end + margin);
  const drop: string[] = [],
    fetch: string[] = [];
  rows.forEach((row, index) => {
    const kept = index >= low && index < high;
    if (!kept && row.image) drop.push(row.id);
    else if (kept && index >= start && index < end && !row.image)
      fetch.push(row.id);
  });
  return { drop, fetch };
}

/** How a favorite, trash or restore selection is sent: owned items in internal batches of `owned`;
 * permitted library items (ids `m:…`) in reviewed requests of up to `permitted`, each one Android
 * confirmation, so a large selection is not one confirmation per 20 items. */
export function changeBatches<T>(
  items: readonly T[],
  id: (row: T) => string,
  sizes: { owned: number; permitted: number },
): T[][] {
  const permitted =
    items.length > 0 && items.every((row) => id(row).startsWith("m:"));
  return batches(items, permitted ? sizes.permitted : sizes.owned);
}

export type BatchRun<T, R> = {
  batch: T[];
  receipt?: R;
  error?: unknown;
  declined?: boolean;
};
/** Sends batches in order. A batch the owner declined (LIBRARY_DECLINED) ends the run: it and every
 * later batch are reported declined and never sent, so Cancel never opens the next confirmation.
 * Returns undefined when `stopped` (the view closed) before a batch. */
export async function runBatches<T, R>(
  groups: readonly T[][],
  send: (batch: T[]) => Promise<R>,
  stopped: () => boolean = () => false,
): Promise<BatchRun<T, R>[] | undefined> {
  const out: BatchRun<T, R>[] = [];
  for (let at = 0; at < groups.length; at++) {
    if (stopped()) return undefined;
    try {
      out.push({ batch: groups[at], receipt: await send(groups[at]) });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "LIBRARY_DECLINED") {
        for (const rest of groups.slice(at))
          out.push({ batch: rest, declined: true });
        break;
      }
      out.push({ batch: groups[at], error });
    }
  }
  return out;
}

/** Days left before Android removes an item from Recently deleted. */
export function daysLeft(
  expiresAt: number | undefined,
  now = Date.now(),
): number | undefined {
  if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0)
    return undefined;
  return Math.max(0, Math.ceil((expiresAt - now) / DAY));
}

/** Grid density: 4 columns by default, pinch for 3 or 5. */
export const GRID_COLUMNS = Object.freeze({ min: 3, default: 4, max: 5 });
export function pinchColumns(
  columns: number,
  startDistance: number,
  distance: number,
): number {
  if (!(startDistance > 0) || !(distance > 0)) return columns;
  const ratio = distance / startDistance;
  const next = ratio > 1.25 ? columns - 1 : ratio < 0.8 ? columns + 1 : columns;
  return Math.max(GRID_COLUMNS.min, Math.min(GRID_COLUMNS.max, next));
}

/** Drag-to-extend: everything between the anchor and the tile under the finger, in grid order. */
export function dragRange<T extends { id: string }>(
  order: readonly T[],
  anchor: string,
  current: string,
): T[] {
  const a = order.findIndex((row) => row.id === anchor),
    b = order.findIndex((row) => row.id === current);
  if (a < 0 || b < 0) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The read-only agent filter (photos_filter). It narrows what the grid shows and never changes media. */
export type PhotosFilter = {
  from?: number;
  to?: number;
  kind?: "image" | "video";
  favorite?: boolean;
  album?: string;
  text?: string;
};
const STOP = new Set([
  "of",
  "at",
  "the",
  "in",
  "on",
  "from",
  "with",
  "and",
  "my",
  "a",
  "an",
  "me",
  "show",
  "find",
]);
export function filterWords(text: unknown): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !STOP.has(word))
    .slice(0, 12);
}
/** On-device text match over date words, kind and orientation. Filenames are never matched. */
export function textMatches(
  row: ViewRow,
  words: readonly string[],
  now = new Date(),
): boolean {
  if (!words.length) return true;
  const time = shotAt(row),
    date = new Date(time),
    ago = Math.round((startOfDay(now.getTime()) - startOfDay(time)) / DAY),
    video = row.kind === "video";
  const bag = [
    video ? "video" : "photo",
    video ? "videos" : "photos",
    video ? "clip" : "picture",
    video ? "clips" : "pictures",
    date.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase(),
    date.toLocaleDateString("en-US", { month: "long" }).toLowerCase(),
    String(date.getFullYear()),
    String(date.getDate()),
  ];
  if (ago === 0) bag.push("today");
  if (ago === 1) bag.push("yesterday");
  if (ago >= 0 && ago < 7) bag.push("week");
  if (date.getDay() === 0 || date.getDay() === 6) bag.push("weekend");
  if (row.favorite)
    bag.push("favorite", "favorites", "favourite", "favourites");
  if (row.folder && /(^|\/)DCIM\/Camera\//i.test(row.folder))
    bag.push("camera");
  if (row.folder && /Screenshots\//i.test(row.folder))
    bag.push("screenshot", "screenshots");
  if (row.width && row.height)
    bag.push(
      row.width > row.height
        ? "landscape"
        : row.width < row.height
          ? "portrait"
          : "square",
    );
  return words.every((word) => bag.some((term) => term.startsWith(word)));
}
export function albumOf(
  row: ViewRow,
  album: string,
  members?: (album: string) => readonly string[] | undefined,
): boolean {
  if (album === "favorites") return !!row.favorite;
  if (album === "videos") return row.kind === "video";
  if (album === "camera")
    return !!row.folder && /(^|\/)DCIM\/Camera\//i.test(row.folder);
  if (album === "screenshots")
    return !!row.folder && /Screenshots\//i.test(row.folder);
  const ids = members?.(album);
  return !!ids && ids.includes(row.id);
}
export function filterMatches(
  row: ViewRow,
  filter: PhotosFilter | undefined,
  members?: (album: string) => readonly string[] | undefined,
  now = new Date(),
): boolean {
  if (!filter) return true;
  const time = shotAt(row);
  if (filter.from !== undefined && time < filter.from) return false;
  if (filter.to !== undefined && time > filter.to) return false;
  if (filter.kind && (row.kind === "video" ? "video" : "image") !== filter.kind)
    return false;
  if (filter.favorite !== undefined && !!row.favorite !== filter.favorite)
    return false;
  if (filter.album && !albumOf(row, filter.album, members)) return false;
  return textMatches(row, filterWords(filter.text), now);
}
/** The chip label: what the filter asks for, in a few words. */
export function filterLabel(
  filter: PhotosFilter,
  albumName?: (album: string) => string | undefined,
): string {
  const parts: string[] = [];
  if (filter.favorite) parts.push("Favorites");
  else if (filter.favorite === false) parts.push("Not favorites");
  if (filter.kind) parts.push(filter.kind === "video" ? "Videos" : "Photos");
  if (filter.album)
    parts.push(
      albumName?.(filter.album) ||
        {
          favorites: "Favorites",
          videos: "Videos",
          camera: "Camera",
          screenshots: "Screenshots",
        }[filter.album] ||
        "Album",
    );
  const day = (time: number) =>
    new Date(time).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  if (filter.from !== undefined && filter.to !== undefined)
    parts.push(
      day(filter.from) === day(filter.to)
        ? day(filter.from)
        : `${day(filter.from)} – ${day(filter.to)}`,
    );
  else if (filter.from !== undefined) parts.push(`Since ${day(filter.from)}`);
  else if (filter.to !== undefined) parts.push(`Until ${day(filter.to)}`);
  const text = filterWords(filter.text).join(" ");
  if (text) parts.push(`“${text}”`);
  return [...new Set(parts)].join(" · ") || "Filter";
}

/** Viewer title: the capture date and time. */
export function viewerTitle(
  time: number,
  now = Date.now(),
): { day: string; time: string } {
  const section = sectionKey(time, now),
    d = new Date(time);
  const day = section.key.startsWith("m:")
    ? d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : section.label;
  return {
    day,
    time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
  };
}
export function formatBytes(size: number | undefined): string {
  if (!size || !Number.isFinite(size) || size <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = size,
    unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Virtualised grid: which rows of which day sections are on screen. Sections are laid out as a
 * header followed by rows of `columns` square tiles separated by `gap`; only rows within the
 * viewport (plus `overscan` rows each way) are rendered, the rest become padding. */
export type GridMetrics = {
  columns: number;
  width: number;
  gap: number;
  header: number;
  scrollTop: number;
  viewport: number;
  overscan: number;
};
export type VirtualSection = {
  index: number;
  from: number;
  to: number;
  padTop: number;
  padBottom: number;
};
export function virtualGrid(
  sizes: readonly number[],
  m: GridMetrics,
): {
  before: number;
  after: number;
  sections: VirtualSection[];
  total: number;
} {
  const columns = Math.max(1, Math.floor(m.columns)),
    gap = Math.max(0, m.gap),
    tile = Math.max(
      1,
      (Math.max(columns, m.width) - gap * (columns - 1)) / columns,
    ),
    pitch = tile + gap;
  const top = Math.max(0, m.scrollTop) - Math.max(0, m.overscan) * pitch,
    bottom =
      Math.max(0, m.scrollTop) +
      Math.max(0, m.viewport) +
      Math.max(0, m.overscan) * pitch;
  const sections: VirtualSection[] = [];
  let y = 0,
    before = 0,
    after = 0;
  sizes.forEach((count, index) => {
    const rows = Math.ceil(Math.max(0, count) / columns),
      body = rows ? rows * tile + (rows - 1) * gap : 0,
      height = m.header + body,
      start = y,
      end = y + height;
    y = end;
    if (end <= top) {
      before += height;
      return;
    }
    if (start >= bottom) {
      after += height;
      return;
    }
    const bodyTop = start + m.header;
    const first = Math.max(
        0,
        Math.min(rows, Math.floor((top - bodyTop) / pitch)),
      ),
      last = Math.max(
        first,
        Math.min(rows, Math.ceil((bottom - bodyTop) / pitch)),
      );
    sections.push({
      index,
      from: first * columns,
      to: Math.min(count, last * columns),
      padTop: first * pitch,
      padBottom: Math.max(
        0,
        (rows - last) * pitch - (first === last && rows ? gap : 0),
      ),
    });
  });
  return { before, after, sections, total: y };
}
