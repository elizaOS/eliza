/**
 * Convert a filesystem path into a well-formed `file://` URL that works on both
 * POSIX and Windows.
 *
 * The naive `file://${path}` form is broken on Windows: an absolute drive path
 * like `C:\Users\me\report.html` has no leading slash and uses backslashes, so
 * `encodeURI("file://C:\\Users\\me\\report.html")` yields
 * `file://C:%5CUsers%5Cme%5Creport.html` — the browser then parses `C:` as the
 * URL *authority/host* and the link fails to open. A valid file URL for a drive
 * path needs three slashes and forward separators: `file:///C:/Users/me/...`.
 *
 * This normalizes backslashes to `/`, guarantees a leading `/` (so a Windows
 * `C:/…` becomes `/C:/…` → `file:///C:/…`), percent-encodes the result, and
 * passes through inputs that are already a URL. It is intentionally
 * dependency-free / browser-safe (no `node:url`) so the report UIs can use it
 * too.
 */
export function toLocalFileUrl(path: string): string {
  // Already an absolute URL (http(s)://, file://, blob:, data:, etc.).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return path;
  }
  const normalized = path.replace(/\\/g, "/");
  const rooted = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return encodeURI(`file://${rooted}`);
}
