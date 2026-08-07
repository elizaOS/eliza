/**
 * Destination resolution for the OIDC sign-in bounce (`/oidc/continue`).
 *
 * The Eliza Cloud OpenID Provider lives on the API origin, but its `/authorize`
 * endpoint can only send a signed-out browser to the console's `/login`, whose
 * `returnTo` is sanitized to a SAME-ORIGIN PATH and therefore cannot carry an
 * absolute URL back. The provider instead parks the validated request and hands
 * over an opaque id; this module turns that id into the absolute resume URL.
 *
 * The destination origin is resolved from a FIXED per-environment table keyed
 * on the current console host — never from a query parameter. A caller-supplied
 * origin would make `/oidc/continue` an open redirect for anyone who can link
 * to it.
 */

const PROD_OIDC_ISSUER_ORIGIN = "https://api.elizacloud.ai";
const STAGING_OIDC_ISSUER_ORIGIN = "https://api-staging.elizacloud.ai";

const STAGING_CONSOLE_HOSTS = new Set([
  "staging.elizacloud.ai",
  "api-staging.elizacloud.ai",
  "app-staging.elizacloud.ai",
]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Opaque request ids are `eoq_` plus 64 lowercase hex characters. */
const REQUEST_ID_RE = /^eoq_[0-9a-f]{64}$/;

export const OIDC_RESUME_PATH = "/api/oidc/authorize/resume";

/**
 * Issuer origin for the current console host. Staging maps to the staging API
 * host so a staging login never resumes against production; local development
 * resolves to the current origin, where the dev server proxies `/api`.
 * Everything else resolves to production — the fail-safe default.
 */
export function resolveOidcIssuerOrigin(
  hostname: string | null | undefined,
  currentOrigin?: string | null,
): string {
  const host = hostname?.trim().toLowerCase() ?? "";
  if (LOCAL_HOSTS.has(host)) return currentOrigin ?? PROD_OIDC_ISSUER_ORIGIN;
  if (
    STAGING_CONSOLE_HOSTS.has(host) ||
    host.endsWith(".staging.elizacloud.ai")
  ) {
    return STAGING_OIDC_ISSUER_ORIGIN;
  }
  return PROD_OIDC_ISSUER_ORIGIN;
}

/**
 * Build the absolute resume URL, or null when the id is missing or malformed.
 * Validating the shape here keeps arbitrary text out of the outbound URL.
 */
export function buildOidcResumeUrl(
  requestId: string | null | undefined,
  hostname: string | null | undefined,
  currentOrigin?: string | null,
): string | null {
  if (!requestId || !REQUEST_ID_RE.test(requestId)) return null;
  const url = new URL(
    OIDC_RESUME_PATH,
    `${resolveOidcIssuerOrigin(hostname, currentOrigin)}/`,
  );
  url.searchParams.set("rid", requestId);
  return url.toString();
}
