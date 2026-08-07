/**
 * Destination resolution for the OIDC sign-in bounce (`/oidc/continue`).
 *
 * The Eliza Cloud OpenID Provider lives on the API origin, but its `/authorize`
 * endpoint can only send a signed-out browser to the console's `/login`, whose
 * `returnTo` is sanitized to a SAME-ORIGIN PATH and therefore cannot carry an
 * absolute URL back. The provider instead parks the validated request and hands
 * over an opaque id; this module turns that id into the absolute resume URL.
 *
 * The destination origin is the ORIGIN OF THE CONFIGURED ISSUER — the build-time
 * `VITE_OIDC_ISSUER_URL`, which must hold the same string the Worker reads as
 * `OIDC_ISSUER_URL`. The hosted consoles get it from the `build:web` env blocks
 * in `.github/workflows/cloud-cf-deploy.yml`, which carry the same per-environment
 * values as the `OIDC_ISSUER_URL` vars in `packages/cloud/api/wrangler.toml`.
 *
 * It is never taken from a query parameter: a caller-supplied origin would make
 * `/oidc/continue` an open redirect for anyone who can link to it. It is not
 * guessed from the console host either; the provider answers only on the one host
 * its issuer names, so a guess that misses lands on a host where the parked
 * request does not exist and the user is told their sign-in expired. Nor is it
 * the console's own origin: the resume leg is authenticated by a per-request
 * binding cookie that `/authorize` set as a HOST-ONLY cookie on the issuer host,
 * so a hop through the console origin's `/api` proxy arrives without it and every
 * sign-in reads as expired.
 *
 * When the issuer is unset, only LOOPBACK development resolves — to the current
 * origin, where the dev server proxies `/api` and the binding cookie therefore
 * belongs to that origin — and every other host resolves to nothing so the page
 * can say which variable is missing.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Opaque request ids are `eoq_` plus 64 lowercase hex characters. */
const REQUEST_ID_RE = /^eoq_[0-9a-f]{64}$/;

export const OIDC_RESUME_PATH = "/api/oidc/authorize/resume";

/** The env var an operator sets to the deployment's `OIDC_ISSUER_URL`. */
export const OIDC_ISSUER_ENV_VAR = "VITE_OIDC_ISSUER_URL";

/**
 * Why a resume URL could not be built. `issuer_unconfigured` is a deployment
 * fault and `invalid_request_id` is an expired or tampered link, and the page
 * must not show one as the other: retrying only helps for the second.
 */
export type OidcResumeTarget =
  | { status: "ok"; url: string }
  | { status: "invalid_request_id" }
  | { status: "issuer_unconfigured" };

/**
 * The configured issuer. `import.meta.env.VITE_OIDC_ISSUER_URL` is written as a
 * literal member so Vite can statically replace it at build time; a computed
 * lookup, or any name without the `VITE_` prefix, is not exposed to the bundle
 * at all and would read as permanently unset.
 */
export function configuredOidcIssuerUrl(): string | undefined {
  const text = import.meta.env?.VITE_OIDC_ISSUER_URL?.trim();
  return text ? text : undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Issuer origin for the current console host, or null when the deployment has
 * not been told one. A path on the configured issuer is dropped: the provider
 * serves `/api/oidc/*` from the host root and rejects a path-bearing issuer
 * outright, so only its origin can be correct here.
 */
export function resolveOidcIssuerOrigin(
  hostname: string | null | undefined,
  currentOrigin?: string | null,
): string | null {
  const configured = configuredOidcIssuerUrl();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // error-policy:J3 untrusted-input sanitizing — an unusable build-time
      // value is reported as "no issuer", never silently replaced by a guess at
      // which API host this console belongs to.
      return null;
    }
  }
  const host = hostname?.trim().toLowerCase() ?? "";
  if (isLoopbackHost(host) && currentOrigin) return currentOrigin;
  return null;
}

/**
 * Build the absolute resume URL, or report which half of the round trip failed.
 * Validating the id shape here keeps arbitrary text out of the outbound URL.
 */
export function buildOidcResumeTarget(
  requestId: string | null | undefined,
  hostname: string | null | undefined,
  currentOrigin?: string | null,
): OidcResumeTarget {
  if (!requestId || !REQUEST_ID_RE.test(requestId)) {
    return { status: "invalid_request_id" };
  }
  const origin = resolveOidcIssuerOrigin(hostname, currentOrigin);
  if (!origin) return { status: "issuer_unconfigured" };

  const url = new URL(OIDC_RESUME_PATH, `${origin}/`);
  url.searchParams.set("rid", requestId);
  return { status: "ok", url: url.toString() };
}
