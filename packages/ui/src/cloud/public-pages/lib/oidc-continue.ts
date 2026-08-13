/**
 * Destination resolution and issuer-session preparation for the OIDC sign-in
 * bounce (`/oidc/continue`).
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
 * binding cookie that `/authorize` set as a HOST-ONLY cookie on the issuer host.
 * Steward's session cookie is also host-only, so this module explicitly syncs
 * the browser's stored Steward token to that issuer origin before resuming.
 *
 * When the issuer is unset, only LOOPBACK development resolves — to the current
 * origin, where the dev server proxies `/api` and the binding cookie therefore
 * belongs to that origin — and every other host resolves to nothing so the page
 * can say which variable is missing.
 */

import {
  readStoredStewardToken,
  STEWARD_SESSION_ENDPOINT,
  syncStewardSession,
} from "@elizaos/shared/steward-session-client";

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
 * Result after both destination validation and issuer-origin session sync.
 * Session failures are deliberately distinct from invalid request ids because
 * retrying the application request cannot repair a missing browser login.
 */
export type PreparedOidcResumeTarget =
  | OidcResumeTarget
  | { status: "session_missing" }
  | { status: "session_sync_failed" };

export interface OidcIssuerSessionDependencies {
  readToken?: () => string | null;
  syncSession?: (token: string, endpoint: string) => Promise<unknown>;
}

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
      const url = new URL(configured);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return url.origin;
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

/**
 * Validate the parked request destination and establish a Steward cookie on
 * the issuer host before `/resume` consumes the request. The sync endpoint is
 * derived from the already issuer-pinned resume target, never from caller
 * input, preserving the open-redirect and cross-tenant boundaries above.
 */
export async function prepareOidcResumeTarget(
  requestId: string | null | undefined,
  hostname: string | null | undefined,
  currentOrigin?: string | null,
  dependencies: OidcIssuerSessionDependencies = {},
): Promise<PreparedOidcResumeTarget> {
  const target = buildOidcResumeTarget(requestId, hostname, currentOrigin);
  if (target.status !== "ok") return target;

  const readToken = dependencies.readToken ?? readStoredStewardToken;
  const token = readToken()?.trim();
  if (!token) return { status: "session_missing" };

  let endpoint: string;
  try {
    endpoint = new URL(STEWARD_SESSION_ENDPOINT, target.url).toString();
  } catch {
    // error-policy:J3 the already validated issuer unexpectedly failed URL
    // construction; report deployment configuration instead of rejecting the
    // continuation promise and leaving the page in a permanent loading state.
    return { status: "issuer_unconfigured" };
  }
  const syncSession =
    dependencies.syncSession ??
    ((stewardToken: string, sessionEndpoint: string) =>
      syncStewardSession(stewardToken, null, { endpoint: sessionEndpoint }));

  try {
    await syncSession(token, endpoint);
  } catch {
    // error-policy:J4 user-facing degrade — a failed cross-origin session sync
    // is shown as an authentication error and the one-time OIDC request is not
    // consumed without the issuer-host session required to authorize it.
    return { status: "session_sync_failed" };
  }

  return target;
}
