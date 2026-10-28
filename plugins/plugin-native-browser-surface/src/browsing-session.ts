/**
 * Saved browser tabs and history for a host with one persistent profile and
 * private tabs: the renderer half of `BrowserSessionPolicy` (Android). Private
 * tabs and their pages never enter a snapshot or history. Invalid rows are
 * dropped, so a damaged or hostile record restores what is valid and nothing
 * else. Hosts own tab views, storage, encryption and these bounds.
 */
export interface BrowsingLimits {
  readonly tabs: number;
  readonly history: number;
  readonly title: number;
}

export const DEFAULT_BROWSING_LIMITS: BrowsingLimits = {
  tabs: 8,
  history: 100,
  title: 200,
};

export interface SavedTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
}

export interface SavedBrowsing {
  readonly history: string[];
  readonly tabs: SavedTab[];
  /** The selected saved tab, or "" when none of the saved tabs is selected. */
  readonly cur: string;
}

/** A host tab as this model reads it: its id and whether it is private. */
export interface BrowsingTab {
  readonly id: string;
  readonly priv?: boolean;
}

const MAX_URL = 4096;
const TAB_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** An http(s) address without credentials, whitespace or control characters. */
export function savedBrowserUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_URL ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Saved addresses never contain controls or whitespace.
    /[\u0000- \u007f]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function savedTitle(value: unknown, limits: BrowsingLimits): string {
  return (
    String(value ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Titles are shown as one line of plain text.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, limits.title)
      .trim()
  );
}

/** Bounded canonical form; invalid rows are dropped rather than stored. */
export function normalizeBrowsing(
  input: unknown,
  limits: BrowsingLimits = DEFAULT_BROWSING_LIMITS,
): SavedBrowsing {
  const record = (input ?? {}) as {
    history?: unknown;
    tabs?: unknown;
    cur?: unknown;
  };
  const history: string[] = [];
  for (const url of Array.isArray(record.history) ? record.history : [])
    if (
      history.length < limits.history &&
      savedBrowserUrl(url) &&
      !history.includes(url)
    )
      history.push(url);
  const tabs: SavedTab[] = [];
  for (const tab of Array.isArray(record.tabs) ? record.tabs : []) {
    const row = (tab ?? {}) as { id?: unknown; url?: unknown; title?: unknown };
    if (
      tabs.length < limits.tabs &&
      typeof row.id === "string" &&
      TAB_ID.test(row.id) &&
      savedBrowserUrl(row.url) &&
      !tabs.some((saved) => saved.id === row.id)
    )
      tabs.push({
        id: row.id,
        url: row.url,
        title: savedTitle(row.title, limits),
      });
  }
  const cur =
    typeof record.cur === "string" && tabs.some((tab) => tab.id === record.cur)
      ? record.cur
      : "";
  return { history, tabs, cur };
}

/**
 * What a host saves: normal tabs with a known address (committed, or restored
 * and not yet loaded) and history. Private tabs and their pages are excluded.
 */
export function browsingSnapshot(
  state: {
    readonly tabs: readonly BrowsingTab[];
    readonly visits: readonly string[];
    readonly cur: string;
  },
  page: (id: string) => { url?: string; title?: string } | undefined,
  limits: BrowsingLimits = DEFAULT_BROWSING_LIMITS,
): SavedBrowsing {
  const tabs: SavedTab[] = [];
  for (const tab of state.tabs) {
    if (tab.priv || tabs.length >= limits.tabs) continue;
    const known = page(tab.id);
    if (known?.url)
      tabs.push({
        id: tab.id,
        url: known.url,
        title: savedTitle(known.title, limits),
      });
  }
  return normalizeBrowsing(
    { history: state.visits, tabs, cur: state.cur },
    limits,
  );
}

/**
 * Merge a saved record into a running host. Saved tabs replace only an
 * untouched single new tab (`pristine`); otherwise only history is merged so
 * nothing open is lost. `restored` lists the tabs the host recreates, each
 * loaded with an ordinary request for its address only when it is shown.
 */
export function restoreBrowsing(
  saved: unknown,
  state: { readonly visits: readonly string[] },
  pristine: boolean,
  limits: BrowsingLimits = DEFAULT_BROWSING_LIMITS,
): { visits: string[]; restored: SavedTab[]; cur?: string } {
  const record = normalizeBrowsing(saved, limits);
  const visits = [
    ...state.visits,
    ...record.history.filter((url) => !state.visits.includes(url)),
  ].slice(0, limits.history);
  if (!pristine || !record.tabs.length) return { visits, restored: [] };
  return {
    visits,
    restored: record.tabs,
    cur: record.cur || record.tabs[0].id,
  };
}
