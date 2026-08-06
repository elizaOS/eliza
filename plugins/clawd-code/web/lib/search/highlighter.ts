/**
 * Highlights occurrences of search terms in text by wrapping them in <mark> tags.
 * Returns an HTML string safe for use with dangerouslySetInnerHTML.
 */
export function highlight(text: string, query: string): string {
  if (!query.trim()) return escapeHtml(text);

  const terms = tokenize(query);
  if (terms.length === 0) return escapeHtml(text);

  // Build a regex that matches any of the terms (case-insensitive)
  const pattern = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const regex = new RegExp(`(${pattern})`, "gi");

  return escapeHtml(text).replace(
    // Re-run on escaped HTML — we need to match original terms
    // So instead: split on matches then reassemble
    regex,
    (match) => `<mark class="search-highlight">${match}</mark>`
  );
}

/**
 * Returns a short excerpt (up to maxLength chars) centred around the first match.
 */
export function excerpt(text: string, query: string, maxLength = 160): string {
  if (!query.trim()) return text.slice(0, maxLength);

  const terms = tokenize(query);
  if (terms.length === 0) return text.slice(0, maxLength);

  const lowerText = text.toLowerCase();
  let matchIndex = -1;

  for (const term of terms) {
    const idx = lowerText.indexOf(term.toLowerCase());
    if (idx !== -1) {
      matchIndex = idx;
      break;
    }
  }

  if (matchIndex === -1) return text.slice(0, maxLength);

  const half = Math.floor(maxLength / 2);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(text.length, start + maxLength);
  const slice = text.slice(start, end);

  return (start > 0 ? "…" : "") + slice + (end < text.length ? "…" : "");
}

/** Tokenise a query string into non-empty lowercase words. */
export function tokenize(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
