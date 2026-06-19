export const RECENT_VIEWS_STORAGE_KEY = "elizaos.views.recent";
export const TOP_VIEW_LIMIT = 8;

export function readRecentViewIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_VIEWS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeRecentViewIds(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RECENT_VIEWS_STORAGE_KEY,
      JSON.stringify(ids.slice(0, TOP_VIEW_LIMIT)),
    );
  } catch {
    /* localStorage unavailable */
  }
}

export function recordRecentViewId(viewId: string): string[] {
  const trimmed = viewId.trim();
  if (!trimmed) return readRecentViewIds();
  const current = readRecentViewIds();
  const next = [trimmed, ...current.filter((id) => id !== trimmed)].slice(
    0,
    TOP_VIEW_LIMIT,
  );
  writeRecentViewIds(next);
  return next;
}
