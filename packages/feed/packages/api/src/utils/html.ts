/**
 * Escape a string for safe insertion into HTML.
 *
 * Replaces the five characters that have special meaning in HTML/XML:
 * `&`, `<`, `>`, `"`, and `'`.
 *
 * @param str - Raw string to escape
 * @returns HTML-safe string
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
