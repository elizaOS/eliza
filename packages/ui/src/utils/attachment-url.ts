/**
 * URL scheme allowlist for attachment rendering.
 *
 * Agent- and connector-provided attachment URLs are rendered directly into the
 * DOM as `href` / `src` attributes (links, images, audio, video, downloads).
 * An untrusted URL with a dangerous scheme - `javascript:`, `vbscript:`,
 * `file:`, `data:text/html`, `data:image/svg+xml`, etc. - can lead to script
 * execution or local-file disclosure when clicked or loaded. To prevent that,
 * every attachment URL MUST be passed through {@link isSafeAttachmentUrl}
 * before it is used as an `href` / `src`, and the media/link must NOT be
 * rendered when it returns `false`.
 *
 * A URL is considered safe ONLY when it is one of:
 *  - an `http://` or `https://` URL;
 *  - a root-relative / app URL (begins with `/`, e.g. `/api/media/<hash>`);
 *  - the on-device local-agent IPC scheme `eliza-local-agent://ipc/…`, which is
 *    how a served `/api/media/<hash>` path resolves in mobile/desktop local mode
 *    (no HTTP port): a native scheme handler serves the bytes over IPC. This is
 *    the ONLY custom scheme permitted, and only for its fixed `ipc` authority;
 *    it is a same-app capability, not an attacker-controlled `foo://` sink;
 *  - a `blob:` URL;
 *  - a `data:` URL whose media type is in the allowlist
 *    (`image/*`, `audio/*`, `video/*`, `application/pdf`, `text/plain`).
 *
 * Everything else returns `false`: other/unknown schemes (`javascript:`,
 * `vbscript:`, `file:`, `mailto:`, any other custom `foo://`, ...), `data:` URLs
 * with a non-allowlisted media type (notably `data:text/html` and
 * `data:image/svg+xml`, both script-capable), empty / whitespace-only input,
 * and malformed input.
 *
 * The check is deliberately strict and conservative: it tolerates surrounding
 * whitespace, embedded control characters (which browsers strip when parsing
 * the scheme, so `java\0script:` must be treated as `javascript:`), and a
 * mixed-case scheme, all of which are common XSS-payload obfuscations.
 */

/**
 * `data:` media type prefixes permitted for inline rendering. `*` allows any
 * subtype (e.g. `image/png`, `audio/mpeg`), except the explicit exclusions in
 * {@link UNSAFE_DATA_MEDIA_TYPES}.
 */
const SAFE_DATA_MEDIA_TYPE_PREFIXES = ["image/", "audio/", "video/"] as const;

const SAFE_DATA_MEDIA_TYPES_EXACT = new Set<string>([
  "application/pdf",
  "text/plain",
]);

// Disallowed even though they would match a prefix above: both can run script.
const UNSAFE_DATA_MEDIA_TYPES = new Set<string>(["image/svg+xml", "text/html"]);

/**
 * The on-device local-agent IPC identity, kept in sync with
 * `MOBILE_LOCAL_AGENT_IPC_BASE` in `first-run/mobile-runtime-mode.ts`. A served
 * `/api/media/<hash>` path resolves to `eliza-local-agent://ipc/api/media/…`
 * when the app runs the bundled agent over IPC (no HTTP port). Duplicated as a
 * bare constant here so this guard stays a zero-import leaf (it is imported into
 * hot render paths); the value is a frozen wire identity, not a moving target.
 */
const LOCAL_AGENT_IPC_SCHEME = "eliza-local-agent";
const LOCAL_AGENT_IPC_HOST = "ipc";

/**
 * True for `eliza-local-agent://ipc` and `eliza-local-agent://ipc/…` only.
 * `sanitized` is the whitespace/control-stripped, scheme-sanitized input; the
 * scheme is already known to be `eliza-local-agent`. Chromium treats this
 * non-special authority as path data (`eliza-local-agent://ipc/x` →
 * authority-less, `//ipc/x` in the path), so match on the literal
 * `//<host>` prefix rather than trusting `URL.hostname`.
 */
function isLocalAgentIpcUrl(sanitized: string): boolean {
  const afterScheme = sanitized
    .slice(`${LOCAL_AGENT_IPC_SCHEME}:`.length)
    .toLowerCase();
  const authority = `//${LOCAL_AGENT_IPC_HOST}`;
  if (afterScheme === authority) return true;
  // Only `/`, `?`, or `#` may follow the fixed authority — never another host
  // char (which would make `//ipcevil/…` a different, disallowed authority).
  return /^\/\/ipc(?:[/?#]|$)/.test(afterScheme);
}

/**
 * Strip ASCII whitespace and C0/DEL control characters the way a browser does
 * before resolving a URL's scheme. This neutralises obfuscation like
 * `java\tscript:` / `java\nscript:` so the scheme test sees `javascript:`.
 * Done by code point to avoid embedding literal control chars in source.
 */
function sanitizeForSchemeCheck(url: string): string {
  let out = "";
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    // Skip C0 controls (0x00-0x1F), space (0x20), and DEL (0x7F).
    if (code <= 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

function isAllowedDataMediaType(mediaType: string): boolean {
  const type = mediaType.toLowerCase();
  if (UNSAFE_DATA_MEDIA_TYPES.has(type)) return false;
  if (SAFE_DATA_MEDIA_TYPES_EXACT.has(type)) return true;
  return SAFE_DATA_MEDIA_TYPE_PREFIXES.some((prefix) =>
    type.startsWith(prefix),
  );
}

/**
 * Returns `true` only for attachment URLs that are safe to render as an
 * `href` / `src`. See the module doc comment for the exact allowlist.
 */
export function isSafeAttachmentUrl(url: string): boolean {
  if (typeof url !== "string") return false;

  const trimmed = url.trim();
  if (!trimmed) return false;

  // Root-relative / app URL (e.g. `/api/media/<hash>`). A scheme-relative URL
  // (`//host/...`) is rejected: it is not an app path and its scheme is
  // ambiguous.
  if (trimmed.startsWith("/")) {
    return !trimmed.startsWith("//");
  }

  // Resolve the scheme the way a browser would: ignore whitespace/control
  // chars, then read up to the first colon.
  const sanitized = sanitizeForSchemeCheck(trimmed);
  const colonIndex = sanitized.indexOf(":");

  // No colon, or a leading colon: not an absolute URL and not root-relative,
  // so reject. (Relative paths like `foo/bar` are never produced for
  // attachments and are not safe to assume an origin for.)
  if (colonIndex <= 0) return false;

  const scheme = sanitized.slice(0, colonIndex).toLowerCase();

  // A scheme must be a valid URL scheme token; anything else is malformed.
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return false;

  switch (scheme) {
    case "http":
    case "https":
    case "blob":
      return true;
    case LOCAL_AGENT_IPC_SCHEME:
      // The bundled on-device agent's media, served over IPC in local mode.
      // Restricted to the fixed `ipc` authority; any other authority is a
      // different, untrusted target and stays rejected.
      return isLocalAgentIpcUrl(sanitized);
    case "data": {
      // Parse the media type out of `data:[<media type>][;base64],<data>`.
      // Use the sanitized string so control-char obfuscation inside the
      // header cannot smuggle a disallowed media type past the check.
      const header = sanitized.slice(sanitized.indexOf(":") + 1);
      const comma = header.indexOf(",");
      // A data: URL with no comma is malformed.
      if (comma < 0) return false;
      const meta = header.slice(0, comma);
      // media type is everything before the first `;` (params like `;base64`).
      const mediaType = meta.split(";")[0]?.trim() ?? "";
      // An empty media type defaults to `text/plain` per the data: URL spec.
      if (!mediaType) return true;
      return isAllowedDataMediaType(mediaType);
    }
    default:
      return false;
  }
}

/**
 * Returns `url` when it is safe to render (per {@link isSafeAttachmentUrl}),
 * otherwise returns `fallback` (default: empty string). Useful for inlining a
 * guarded value directly into an `href` / `src`.
 */
export function safeAttachmentUrl(url: string, fallback = ""): string {
  return isSafeAttachmentUrl(url) ? url : fallback;
}
