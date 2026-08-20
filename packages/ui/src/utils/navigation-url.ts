/**
 * Scheme allowlist for browser navigations to API- or plugin-supplied URLs.
 *
 * Billing checkout links, connector OAuth `authUrl`s, pairing `redirectUrl`s,
 * onboarding `returnUrl`s, and server-signed download URLs all arrive over the
 * wire and are then assigned to `window.location.href` / `location.assign`,
 * opened via `window.open`, navigated into a pre-opened popup, or rendered
 * into an `href`. Unlike JSX URL props (which React 19 guards), a
 * `javascript:` value assigned to `location` executes synchronously in the
 * page origin — and a pre-opened about:blank popup is guaranteed same-origin,
 * so `popup.location.href = "javascript:…"` is a straight top-window script
 * execution. Every wire-supplied navigation target MUST pass through
 * {@link isSafeNavigationUrl} first, and an invalid target MUST surface the
 * explicit error state the handler already renders instead of navigating. The
 * central `openExternalUrl` / `navigatePreOpenedWindow` helpers in
 * `./openExternalUrl` enforce this for every caller.
 *
 * Only absolute `http:`/`https:` URLs pass by default (loopback `http:` stays
 * valid for local dev flows); callers with a documented extra scheme (e.g. the
 * onboarding `sms:` return link) opt in explicitly via `extraSchemes`.
 * `new URL()` normalizes away control-char scheme obfuscation (e.g.
 * `java\tscript:`), so the parsed protocol is the scheme the browser would
 * use.
 */

/**
 * Returns `true` only for absolute URLs whose scheme is http(s) — or one of
 * the caller-declared `extraSchemes` (protocol strings including the colon,
 * e.g. `["sms:"]`). Everything else (`javascript:`, `data:`, `file:`,
 * `vbscript:`, arbitrary custom schemes, relative/root-relative input,
 * malformed input, non-string input) returns `false`.
 */
export function isSafeNavigationUrl(
  url: unknown,
  extraSchemes: readonly string[] = [],
): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 untrusted navigation target from an API response —
    // malformed input fails closed, never navigates.
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return true;
  return extraSchemes.includes(parsed.protocol);
}
