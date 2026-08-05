/**
 * Client side of the elizacloud.ai ↔ app.elizacloud.ai SSO bridge — shared
 * login across the dashboard origin and the Eliza app-mode origin without a
 * shared cookie.
 *
 * SECURITY MODEL (server rationale in
 * `packages/cloud/api/auth/sso-bridge/route.ts`): the Steward session JWT the
 * SPA runs on is per-origin localStorage. Mirroring it into a JS-readable
 * `Domain=elizacloud.ai` cookie is rejected because user-controlled content is
 * served on sibling subdomains — user apps on `<id>.apps.elizacloud.ai`,
 * dedicated-agent web UIs on `<sandboxId>.elizacloud.ai`, uploaded blobs on
 * `blob.elizacloud.ai` — and a parent-domain non-HttpOnly cookie is readable by
 * JS on every one of them; cookies cannot scope to "apex + one subdomain
 * only". Instead the app origin redirects through the dashboard origin, which
 * mints a 60-second single-use opaque code that the app origin exchanges for
 * the token over POST. The token never appears in a URL.
 *
 * The handshake is bound to the initiating app origin by a `state` nonce:
 * created here, persisted in the app origin's sessionStorage (readable by no
 * other origin), echoed through both redirect legs, and verified-and-consumed
 * before any exchange call. A mismatch aborts to the app's own login — an
 * attacker who mints a code for their own session cannot drive a victim's
 * browser through the exchange leg (login CSRF / session fixation).
 *
 * Hostname gating is a strict hardcoded allowlist: only the real app hosts
 * initiate/exchange, only their paired dashboard hosts mint, and every other
 * hostname — localhost/dev (even with `VITE_FORCE_APP_MODE`), previews,
 * per-agent subdomains — resolves to role "none" and the bridge is inert.
 *
 * Logout stays logged out (both hosts): explicit app-host sign-out records a
 * persistent local marker that suppresses auto-bridging until the next real
 * sign-in, and calls the server logout route, which stamps a server-side
 * logout marker the mint/exchange endpoints refuse to bridge across. Dashboard
 * sign-out clears the dashboard's localStorage session (the only mint
 * credential) and the domain-wide `steward-authed` marker cookie this module
 * pre-checks, so a logged-out browser never even attempts the bounce.
 */

import {
  hasStewardAuthedCookie,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { appModeNavigation } from "../app-mode/app-mode";
import { decodeJwtPayload } from "../lib/jwt";
import {
  clearStaleStewardSession,
  configuredSessionEndpoint,
} from "../shell/StewardProviderShared";
import { ELIZA_CLOUD_DIRECT_API_BY_HOST } from "../shell/steward-url";

/** Client route (registered on every host; role-switched by hostname). */
export const SSO_BRIDGE_PATH = "/auth/bridge";

/**
 * The two deployed origin pairs. Staging must bridge to staging — a staging
 * app host minting against the production dashboard would splice sessions
 * across environments. Origins are hardcoded canonical values, never derived
 * from request input.
 */
interface SsoBridgePair {
  mintHosts: readonly string[];
  mintOrigin: string;
  appHost: string;
  appOrigin: string;
}

const SSO_BRIDGE_PAIRS: readonly SsoBridgePair[] = [
  {
    mintHosts: ["elizacloud.ai", "www.elizacloud.ai"],
    mintOrigin: "https://elizacloud.ai",
    appHost: "app.elizacloud.ai",
    appOrigin: "https://app.elizacloud.ai",
  },
  {
    mintHosts: ["staging.elizacloud.ai"],
    mintOrigin: "https://staging.elizacloud.ai",
    appHost: "app-staging.elizacloud.ai",
    appOrigin: "https://app-staging.elizacloud.ai",
  },
];

export type SsoBridgeRole = "mint" | "exchange" | "none";

function pairForHostname(hostname: string): SsoBridgePair | null {
  const host = hostname.toLowerCase();
  for (const pair of SSO_BRIDGE_PAIRS) {
    if (pair.appHost === host || pair.mintHosts.includes(host)) return pair;
  }
  return null;
}

/**
 * Which side of the handshake this hostname plays. Exact-match only:
 * `foo.elizacloud.ai`, `elizacloud.ai.evil.com`, `localhost`, previews, and
 * the dev app-mode flag all resolve to "none".
 */
export function ssoBridgeRoleForHostname(hostname: string): SsoBridgeRole {
  const host = hostname.toLowerCase();
  const pair = pairForHostname(host);
  if (!pair) return "none";
  return pair.appHost === host ? "exchange" : "mint";
}

/** Cloud API worker base for a bridge hostname; null off the deployed map. */
function apiBaseForHostname(hostname: string): string | null {
  return ELIZA_CLOUD_DIRECT_API_BY_HOST[hostname.toLowerCase()] ?? null;
}

/** The app origin paired with a MINT hostname; null for non-mint hosts. */
export function pairedAppOrigin(mintHostname: string): string | null {
  const pair = pairForHostname(mintHostname);
  if (!pair || pair.appHost === mintHostname.toLowerCase()) return null;
  return pair.appOrigin;
}

// ---------------------------------------------------------------------------
// returnTo sanitation
// ---------------------------------------------------------------------------

const RETURN_TO_MAX_LENGTH = 2000;

/**
 * returnTo travels through two cross-origin redirects, so it must stay a
 * same-origin path: absolute URLs, protocol-relative "//", "/\" (which
 * browsers normalize to "//"), any backslash, and the bridge path itself
 * (self-redirect loop) are all rejected to "/".
 */
export function sanitizeBridgeReturnTo(
  value: string | null | undefined,
): string {
  if (!value || value.length > RETURN_TO_MAX_LENGTH) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.includes("\\")) return "/";
  const path = value.split(/[?#]/, 1)[0];
  if (path === SSO_BRIDGE_PATH) return "/";
  return value;
}

// ---------------------------------------------------------------------------
// State nonce (defect fix: handshake binding)
// ---------------------------------------------------------------------------

const SSO_STATE_KEY = "eliza_sso_bridge_state";
const SSO_STATE_RE = /^[0-9a-f]{64}$/;

/** Both legs validate the echoed state's shape before using it in a URL. */
export function isWellFormedSsoState(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && SSO_STATE_RE.test(value);
}

/**
 * Create the handshake nonce and persist it in THIS origin's sessionStorage.
 * Returns null when storage or crypto is unavailable (privacy mode) — the
 * caller must then fall back to the normal login flow instead of bridging,
 * because an unbound handshake is exactly the CSRF this nonce exists to stop.
 */
export function createSsoBridgeState(): string | null {
  try {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const state = Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    sessionStorage.setItem(SSO_STATE_KEY, state);
    return state;
  } catch {
    // error-policy:J4 no storage/crypto → the bridge is disabled for this
    // visit (fail-closed to the ordinary login), never an unbound handshake.
    return null;
  }
}

/** Read AND delete the stored nonce — verification is strictly single-shot. */
export function consumeSsoBridgeState(): string | null {
  try {
    const state = sessionStorage.getItem(SSO_STATE_KEY);
    sessionStorage.removeItem(SSO_STATE_KEY);
    return state;
  } catch {
    // error-policy:J4 unreadable storage verifies as "no stored state" → the
    // exchange leg aborts to login (fail-closed).
    return null;
  }
}

// ---------------------------------------------------------------------------
// Redirect-loop guard
// ---------------------------------------------------------------------------

const SSO_ATTEMPT_KEY = "eliza_sso_bridge_attempted_at";
const SSO_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

/**
 * A failed handshake (no dashboard session, expired code, cache down) must
 * fall back to the app origin's own /login instead of bouncing to the
 * dashboard again — otherwise an unauthenticated visitor ping-pongs between
 * the origins forever. The marker is set right before leaving for the
 * dashboard, cleared only by a successful exchange, and ages out on its own so
 * a later visit retries.
 */
export function shouldAttemptSsoBridge(now: number = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(SSO_ATTEMPT_KEY);
    if (!raw) return true;
    const at = Number(raw);
    if (Number.isNaN(at)) return true;
    return now - at > SSO_ATTEMPT_WINDOW_MS;
  } catch {
    // error-policy:J4 no sessionStorage → no way to break a redirect loop, so
    // never auto-bounce; the user still has the normal login flow.
    return false;
  }
}

export function markSsoBridgeAttempt(now: number = Date.now()): void {
  try {
    sessionStorage.setItem(SSO_ATTEMPT_KEY, String(now));
  } catch {
    // error-policy:J6 best-effort marker; shouldAttemptSsoBridge already
    // fails closed when storage is unavailable.
  }
}

export function clearSsoBridgeAttempt(): void {
  try {
    sessionStorage.removeItem(SSO_ATTEMPT_KEY);
  } catch {
    // error-policy:J6 best-effort cleanup of an advisory marker.
  }
}

// ---------------------------------------------------------------------------
// Logged-out marker (defect fix: logout stays logged out)
// ---------------------------------------------------------------------------

const SSO_LOGGED_OUT_KEY = "eliza_sso_logged_out";

/**
 * Persistent (localStorage) "the user explicitly signed out here" marker. It
 * suppresses AUTO-bridging only — an explicit login is always available — and
 * is cleared by the next successful sign-in on this origin (any mechanism),
 * so logout cannot be silently undone by the other origin's surviving session.
 */
export function isSsoLoggedOut(): boolean {
  try {
    return localStorage.getItem(SSO_LOGGED_OUT_KEY) === "1";
  } catch {
    // error-policy:J4 unreadable storage reads as "logged out" so the bridge
    // never auto-runs somewhere it cannot honor a logout marker.
    return true;
  }
}

export function markSsoLoggedOut(): void {
  try {
    localStorage.setItem(SSO_LOGGED_OUT_KEY, "1");
  } catch {
    // error-policy:J6 best-effort marker; isSsoLoggedOut fails closed when
    // storage is unavailable.
  }
}

export function clearSsoLoggedOut(): void {
  try {
    localStorage.removeItem(SSO_LOGGED_OUT_KEY);
  } catch {
    // error-policy:J6 best-effort cleanup; an over-persistent marker only
    // suppresses auto-bridge, never login itself.
  }
}

// ---------------------------------------------------------------------------
// Handshake URLs
// ---------------------------------------------------------------------------

/** Dashboard-origin URL the app origin leaves for when it has no session. */
export function buildBridgeMintUrl(
  appHostname: string,
  state: string,
  returnTo: string,
): string | null {
  const pair = pairForHostname(appHostname);
  if (!pair || pair.appHost !== appHostname.toLowerCase()) return null;
  if (!isWellFormedSsoState(state)) return null;
  const safe = sanitizeBridgeReturnTo(returnTo);
  return `${pair.mintOrigin}${SSO_BRIDGE_PATH}?state=${encodeURIComponent(state)}&returnTo=${encodeURIComponent(safe)}`;
}

/** App-origin URL the dashboard redirects back to after minting a code. */
export function buildBridgeExchangeUrl(
  mintHostname: string,
  code: string,
  state: string,
  returnTo: string,
): string | null {
  const pair = pairForHostname(mintHostname);
  if (!pair || pair.appHost === mintHostname.toLowerCase()) return null;
  if (!isWellFormedSsoState(state)) return null;
  const safe = sanitizeBridgeReturnTo(returnTo);
  return `${pair.appOrigin}${SSO_BRIDGE_PATH}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&returnTo=${encodeURIComponent(safe)}`;
}

// ---------------------------------------------------------------------------
// Entry decision + initiation (app host)
// ---------------------------------------------------------------------------

/**
 * Whether an unauthenticated app-mode visit should leave for the dashboard
 * bridge right now. True only on the real app hosts, when the user has not
 * explicitly signed out here, when the domain-wide `steward-authed` marker
 * says a server session exists to bridge FROM (after any logout that marker
 * is cleared domain-wide, so a logged-out browser skips the bounce entirely),
 * and while the loop guard is clear.
 */
export function shouldAutoBridgeToSso(
  hostname: string = window.location.hostname,
  now: number = Date.now(),
): boolean {
  if (ssoBridgeRoleForHostname(hostname) !== "exchange") return false;
  if (isSsoLoggedOut()) return false;
  if (!hasStewardAuthedCookie()) return false;
  return shouldAttemptSsoBridge(now);
}

/**
 * Leave for the dashboard mint leg: create + store the state nonce, mark the
 * attempt, and replace the location (the gate page is transient — Back must
 * not re-enter it). Returns false when the bridge cannot start (no nonce
 * storage / unknown host); the caller falls back to the ordinary login.
 */
export function redirectToSsoBridge(
  returnTo: string,
  hostname: string = window.location.hostname,
): boolean {
  const state = createSsoBridgeState();
  if (!state) return false;
  const url = buildBridgeMintUrl(hostname, state, returnTo);
  if (!url) return false;
  markSsoBridgeAttempt();
  appModeNavigation.replace(url);
  return true;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

const SSO_CODE_RE = /^esso_[0-9a-f]{64}$/;

/** Both legs validate the code's shape before trusting it in a URL / POST. */
export function isWellFormedSsoCode(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && SSO_CODE_RE.test(value);
}

export type SsoMintResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

/**
 * Dashboard side: trade the local session for a one-time code. The Bearer
 * token comes from THIS origin's localStorage — deliberately never from the
 * parent-domain cookie, which JS on user-content subdomains can plant (the
 * server enforces the same rule). No refresh token travels: the app origin
 * already shares the HttpOnly domain refresh cookie.
 */
export async function mintSsoCode(
  hostname: string,
  fetchFn: typeof fetch = fetch,
): Promise<SsoMintResult> {
  const base = apiBaseForHostname(hostname);
  if (!base) return { ok: false, error: "Host cannot mint SSO codes" };
  const token = readStoredStewardToken();
  if (!token) return { ok: false, error: "No local session" };
  try {
    const res = await fetchFn(`${base}/api/auth/sso-bridge/mint`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok)
      return { ok: false, error: `Mint failed (HTTP ${res.status})` };
    const body = (await res.json().catch(() => null)) as {
      code?: unknown;
    } | null;
    const code = typeof body?.code === "string" ? body.code : null;
    if (!code || !isWellFormedSsoCode(code)) {
      return { ok: false, error: "Mint returned no usable code" };
    }
    return { ok: true, code };
  } catch (err) {
    // error-policy:J1 transport failure becomes the typed failure result the
    // bridge route turns into its fall-back-to-login redirect.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type SsoExchangeResult = { ok: true } | { ok: false; error: string };

function tokenLooksHydratable(token: string): boolean {
  const claims = decodeJwtPayload(token);
  const id = claims?.userId ?? claims?.sub;
  if (typeof id !== "string" || id.trim().length === 0) return false;
  if (typeof claims?.exp !== "number") return false;
  return claims.exp * 1000 > Date.now();
}

/**
 * App side: consume the code and hydrate this origin's localStorage mirror.
 * After this the app origin is indistinguishable from one the user logged
 * into directly: same storage key, same `steward-token-sync` event, and the
 * existing AuthTokenSync loop takes over cookie sync + refresh (the HttpOnly
 * refresh cookie is domain-wide and already present).
 */
export async function performSsoExchange(
  code: string,
  hostname: string,
  fetchFn: typeof fetch = fetch,
): Promise<SsoExchangeResult> {
  const base = apiBaseForHostname(hostname);
  if (!base) return { ok: false, error: "Host cannot exchange SSO codes" };
  try {
    const res = await fetchFn(`${base}/api/auth/sso-bridge/exchange`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      return { ok: false, error: `Exchange failed (HTTP ${res.status})` };
    }
    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token : null;
    if (!token || !tokenLooksHydratable(token)) {
      return { ok: false, error: "Exchange returned no usable session" };
    }

    writeStoredStewardToken(token);

    // Same call the login flow makes: sets the HttpOnly steward cookies + the
    // authed marker for this environment. Best-effort — the domain cookies
    // normally already exist (they are what the bridge bridged from), and
    // AuthTokenSync retries this sync for as long as the session lives.
    try {
      await fetchFn(configuredSessionEndpoint(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      // error-policy:J6 best-effort cookie sync; the localStorage session is
      // established and AuthTokenSync re-syncs on its own cadence.
    }

    clearSsoBridgeAttempt();
    clearSsoLoggedOut();
    try {
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    } catch {
      // error-policy:J6 best-effort notification; storage listeners re-read
      // on their own triggers.
    }
    return { ok: true };
  } catch (err) {
    // error-policy:J1 transport failure becomes the typed failure result the
    // bridge route turns into its fall-back-to-login redirect.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Sign-out (defect fix: logout stays logged out)
// ---------------------------------------------------------------------------

/**
 * Explicit sign-out on an app-mode host. Order matters: the local logged-out
 * marker lands synchronously first (auto-bridge is suppressed even if the
 * network never answers), the server logout request is ISSUED while the
 * session cookies are still in the jar (it ends the server-side sessions AND
 * stamps the server logout marker that blocks minting for pre-logout tokens),
 * and the local scrub stays synchronous so the login page never renders over
 * a half-signed-out session. The returned promise settles with the server
 * teardown; callers may ignore it.
 */
export async function signOutFromSsoBridgedHost(
  hostname: string = window.location.hostname,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  markSsoLoggedOut();
  const base = apiBaseForHostname(hostname);
  const serverLogout = base
    ? fetchFn(`${base}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      }).catch(() => undefined)
    : // error-policy:J6 best-effort server teardown — the local marker is
      // already set and the local scrub below always runs.
      Promise.resolve(undefined);
  clearStaleStewardSession();
  await serverLogout;
}
