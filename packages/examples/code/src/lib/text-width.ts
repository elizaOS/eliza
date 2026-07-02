import { visibleWidth } from "@elizaos/tui";

/**
 * Pad `s` with trailing spaces so its VISIBLE width reaches `target`.
 *
 * Unlike `String.prototype.padEnd`, this ignores ANSI SGR (color) codes.
 * padEnd counts a chalk-styled string's invisible escape bytes toward its
 * length, so padding a short colored string (a task header, a status line, the
 * composer prompt) added too few spaces — the box's right `│` border collapsed
 * inward against the text on every styled row. Overflow beyond `target` is left
 * to the caller / MainScreen's `truncateToWidth`.
 */
export function padEndVisible(s: string, target: number): string {
  const width = visibleWidth(s);
  return width >= target ? s : s + " ".repeat(target - width);
}
