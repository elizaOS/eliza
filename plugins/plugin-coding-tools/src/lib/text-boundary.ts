/** Exact CR/LF suffix; "none" means neither. Never normalizes content. */
export function finalLineEnding(text: string): "none" | "LF" | "CRLF" | "CR" {
  if (text.endsWith("\r\n")) return "CRLF";
  if (text.endsWith("\n")) return "LF";
  if (text.endsWith("\r")) return "CR";
  return "none";
}

/** Characters in one page of a long tool output read into the model. */
export const DEFAULT_PAGE_CHARS = 12_000;

/**
 * Start of a page at `requested`: clamped to `text`, and one unit earlier
 * when it would split a surrogate pair.
 */
export function normalizePageStart(text: string, requested: number): number {
  let start = Math.max(0, Math.min(text.length, Math.floor(requested)));
  if (
    start > 0 &&
    start < text.length &&
    text.charCodeAt(start) >= 0xdc00 &&
    text.charCodeAt(start) <= 0xdfff &&
    text.charCodeAt(start - 1) >= 0xd800 &&
    text.charCodeAt(start - 1) <= 0xdbff
  )
    start -= 1;
  return start;
}

/**
 * End of a page of at most `limit` units from `start`: one unit shorter when
 * it would split a surrogate pair, and never empty while text remains.
 */
export function normalizePageEnd(
  text: string,
  start: number,
  limit: number,
): number {
  let end = Math.min(text.length, start + limit);
  if (
    end > start &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    end -= 1;
  if (end === start && start < text.length)
    end = Math.min(text.length, start + 2);
  return end;
}
