/**
 * Whitelist / scheme-validate a `triggerAuth()` response from
 * `coding-agent-adapters` before forwarding it to the browser.
 *
 * The adapter's response shape is typed as `unknown` upstream and
 * could in principle carry access tokens, refresh tokens, or other
 * internal secrets in unexpected fields. The HTTP route must only
 * surface the fields the UI actually renders, and must reject any
 * URL whose scheme isn't plain http(s) to prevent a malicious or
 * compromised adapter from smuggling a `javascript:` / `data:` /
 * `file:` URL into an `<a href>`.
 *
 * Extracted into its own module so the sanitizer is unit-testable
 * without spinning up the whole HTTP server.
 */

export interface SanitizedAuthResult {
  launched?: boolean;
  url?: string;
  deviceCode?: string;
  instructions?: string;
}

export function sanitizeAuthResult(input: unknown): SanitizedAuthResult {
  if (!input || typeof input !== "object") return {};
  const r = input as Record<string, unknown>;
  const out: SanitizedAuthResult = {};
  if (typeof r.launched === "boolean") out.launched = r.launched;
  if (typeof r.url === "string") {
    try {
      const parsed = new URL(r.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        out.url = r.url;
      }
    } catch {
      // Malformed URL — drop it. The UI falls back to `instructions`.
    }
  }
  if (typeof r.deviceCode === "string") out.deviceCode = r.deviceCode;
  if (typeof r.instructions === "string") out.instructions = r.instructions;
  return out;
}
