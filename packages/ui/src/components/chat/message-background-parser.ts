/**
 * Parser for the `[BACKGROUND]` chat marker — a bare marker (no body) the
 * BACKGROUND action emits so "change my background" renders a live wallpaper
 * picker inline (the `BackgroundSettingsControls` filmstrip inside a chat
 * widget shell). The picker itself is self-contained state, so unlike
 * `[WORKFLOW]`/`[FORM]` there is no JSON payload to parse — the match carries
 * only its character bounds. With the launcher long-press picker removed on the
 * base branch, chat + Settings are the only two background surfaces.
 *
 * Mirrors the region-shape contract the other inline-widget parsers use so
 * `parseSegments` can collect it generically. Kept React-free for unit tests.
 */

/** The single background marker; matched globally so repeats each render. */
export const BACKGROUND_RE = /\[BACKGROUND\]/g;

export interface BackgroundMatch {
  start: number;
  end: number;
}

/** Find every `[BACKGROUND]` marker in `text` and return its character region. */
export function findBackgroundRegions(text: string): BackgroundMatch[] {
  const results: BackgroundMatch[] = [];
  BACKGROUND_RE.lastIndex = 0;
  let m: RegExpExecArray | null = BACKGROUND_RE.exec(text);
  while (m !== null) {
    results.push({ start: m.index, end: m.index + m[0].length });
    m = BACKGROUND_RE.exec(text);
  }
  return results;
}
