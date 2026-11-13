/**
 * Address-bar input parsing for the browser workspace. Kept import-free so
 * `node --test` can load it directly.
 */

// Schemes that have no `//` but must not be read as `host:port`.
const OPAQUE_INPUT_SCHEME =
  /^(about|blob|data|file|javascript|mailto|sms|tel|vbscript|view-source):/i;

export type BrowserWorkspaceInputUrl =
  | { ok: true; url: string }
  | { ok: false; reason: "empty" | "invalid" | "unsupported" };

/**
 * Normalize what the user typed in the address bar (or passed with
 * `?browse=`). `localhost:3000` and `example.com:8443/x` are a host and
 * port, not a scheme, so they get `https://`. Root-relative paths are
 * resolved by the caller.
 */
export function parseBrowserWorkspaceInputUrl(
  raw: string,
): BrowserWorkspaceInputUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed === "about:blank") return { ok: true, url: trimmed };
  const candidate =
    /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || OPAQUE_INPUT_SCHEME.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: true, url: parsed.toString() };
}
