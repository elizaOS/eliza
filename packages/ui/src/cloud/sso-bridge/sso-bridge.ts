/**
 * Client side of the eliza.app ↔ cloud.eliza.app SSO bridge — shared login
 * across the public/auth origin and the managed Eliza app origin without a
 * shared cookie.
 *
 * SECURITY MODEL (server rationale in
 * `packages/cloud/api/auth/sso-bridge/route.ts`): the Steward session JWT the
 * SPA runs on is per-origin localStorage. Mirroring it into a JS-readable
 * parent-domain cookie is rejected because user-controlled content is served
 * on sibling subdomains such as hosted apps, dedicated-agent web UIs, and
 * uploaded blobs. A parent-domain non-HttpOnly cookie would be readable by JS
 * on every one of them; cookies cannot scope to "apex + one subdomain only".
 * Instead the managed app redirects through the eliza.app auth origin, which
 * mints a 60-second single-use opaque code that the app origin exchanges for
 * the token over POST. The token never appears in a URL.
 *
 * The handshake is bound to the initiating app origin twice over:
 *  - a `state` nonce: created here, persisted in the app origin's
 *    sessionStorage (readable by no other origin), echoed through both
 *    redirect legs, and verified-and-consumed before any exchange call. A
 *    mismatch aborts to the app's own login — an attacker who mints a code
 *    for their own session cannot drive a victim's browser through the
 *    exchange leg (login CSRF / session fixation) — and BURNS the code
 *    server-side so the abandoned code cannot be redeemed later.
 *  - a PKCE-style `verifier`: also created here and held ONLY in this
 *    origin's sessionStorage; its sha256 (`challenge`) rides the mint leg and
 *    is stored with the code, and the raw verifier travels once, in the
 *    exchange POST body. Both handshake URLs carry only the code/challenge,
 *    so HTTP logs and browser history on either origin never contain enough
 *    to redeem a code.
 *
 * Hostname gating is a strict hardcoded allowlist: only the real app hosts
 * initiate/exchange, only their paired eliza.app auth hosts mint, and every other
 * hostname — localhost/dev (even with `VITE_FORCE_APP_MODE`), previews,
 * per-agent subdomains — resolves to role "none" and the bridge is inert.
 *
 * Logout stays logged out (both hosts): explicit sign-out on EITHER host
 * (`signOutFromSsoBridgedHost` — the unified app's account action uses it)
 * records a persistent local marker that suppresses auto-bridging until the
 * next real sign-in, and calls the server logout route, which stamps a
 * server-side Postgres logout marker. The mint/exchange endpoints refuse to
 * bridge across that marker, the cookie-planting session-sync endpoint
 * refuses pre-logout tokens with `session_ended` (so the paired origin's
 * surviving session cannot re-plant the host cookies and clears itself on its
 * next sync), and the explicit app-origin logout marker prevents a bounce.
 */

import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import {
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { shellLocalStorage } from "../../surface-realm-channel";
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
 * app host minting against the production auth origin would splice sessions
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
    mintHosts: ["eliza.app", "www.eliza.app"],
    mintOrigin: ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin,
    appHost: "cloud.eliza.app",
    appOrigin: ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin,
  },
  {
    mintHosts: ["staging.eliza.app"],
    mintOrigin: ELIZA_DOMAIN_CONTRACTS.staging.marketingOrigin,
    appHost: "cloud-staging.eliza.app",
    appOrigin: ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin,
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
// State nonce + PKCE verifier (defect fix: handshake binding + code theft)
// ---------------------------------------------------------------------------

const SSO_STATE_KEY = "eliza_sso_bridge_state";
const SSO_VERIFIER_KEY = "eliza_sso_bridge_verifier";
const SSO_STATE_RE = /^[0-9a-f]{64}$/;

/** Both legs validate the echoed state's shape before using it in a URL. */
export function isWellFormedSsoState(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && SSO_STATE_RE.test(value);
}

/** Challenge/verifier share the state's 64-hex shape (32 random bytes). */
export function isWellFormedSsoChallenge(
  value: string | null | undefined,
): value is string {
  return isWellFormedSsoState(value);
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create the handshake secrets and persist them in THIS origin's
 * sessionStorage: the `state` nonce (echoed through both redirect URLs) and
 * the PKCE-style `verifier` (never leaves this origin until the exchange POST
 * body). Only the verifier's sha256 — the `challenge` — is returned for the
 * mint URL. Returns null when storage or crypto is unavailable (privacy
 * mode) — the caller must then fall back to the normal login flow instead of
 * bridging, because an unbound handshake is exactly the CSRF and code-theft
 * surface these two values exist to stop.
 */
export async function createSsoBridgeHandshake(): Promise<{
  state: string;
  challenge: string;
} | null> {
  try {
    const state = randomHex32();
    const verifier = randomHex32();
    const challenge = await sha256Hex(verifier);
    sessionStorage.setItem(SSO_STATE_KEY, state);
    sessionStorage.setItem(SSO_VERIFIER_KEY, verifier);
    return { state, challenge };
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

/** Read AND delete the stored verifier — the exchange POST is single-shot. */
export function consumeSsoBridgeVerifier(): string | null {
  try {
    const verifier = sessionStorage.getItem(SSO_VERIFIER_KEY);
    sessionStorage.removeItem(SSO_VERIFIER_KEY);
    return verifier;
  } catch {
    // error-policy:J4 unreadable storage verifies as "no verifier" → the
    // exchange leg burns the code and aborts to login (fail-closed).
    return null;
  }
}

// ---------------------------------------------------------------------------
// Redirect-loop guard
// ---------------------------------------------------------------------------

const SSO_ATTEMPT_KEY = "eliza_sso_bridge_attempted_at";
const SSO_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

/**
 * A failed handshake (no auth-origin session, expired code, cache down) must
 * fall back to the app origin's own /login instead of bouncing to the
 * auth origin again — otherwise an unauthenticated visitor ping-pongs between
 * the origins forever. The marker is set right before leaving for the
 * auth origin, cleared only by a successful exchange, and ages out on its own so
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
    // Reserved shell key: raw localStorage writes throw SurfaceRealmDeniedError
    // while a view scope is foreground (surface-realm-broker guard, #13452).
    shellLocalStorage.setItem(SSO_LOGGED_OUT_KEY, "1");
  } catch {
    // error-policy:J6 best-effort marker; isSsoLoggedOut fails closed when
    // storage is unavailable.
  }
}

export function clearSsoLoggedOut(): void {
  try {
    shellLocalStorage.removeItem(SSO_LOGGED_OUT_KEY);
  } catch {
    // error-policy:J6 best-effort cleanup; an over-persistent marker only
    // suppresses auto-bridge, never login itself.
  }
}

// ---------------------------------------------------------------------------
// Handshake URLs
// ---------------------------------------------------------------------------

/**
 * Dashboard-origin URL the app origin leaves for when it has no session.
 * Carries the state nonce and the CHALLENGE (sha256 of the verifier) — never
 * the verifier itself, so this URL grants nothing to whoever logs it.
 */
export function buildBridgeMintUrl(
  appHostname: string,
  state: string,
  challenge: string,
  returnTo: string,
): string | null {
  const pair = pairForHostname(appHostname);
  if (!pair || pair.appHost !== appHostname.toLowerCase()) return null;
  if (!isWellFormedSsoState(state)) return null;
  if (!isWellFormedSsoChallenge(challenge)) return null;
  const safe = sanitizeBridgeReturnTo(returnTo);
  return `${pair.mintOrigin}${SSO_BRIDGE_PATH}?state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(challenge)}&returnTo=${encodeURIComponent(safe)}`;
}

/** Managed-app URL the auth origin redirects back to after minting a code. */
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
 * Whether an unauthenticated app-mode visit should leave for the auth origin
 * bridge right now. True only on the real app hosts, when the user has not
 * explicitly signed out here, and while the loop guard is clear.
 *
 * Steward cookies are deliberately host-only, so the app origin cannot use an
 * auth-origin cookie as a preflight hint. The first bridge visit is therefore
 * also the signed-out login handoff: the mint route remembers the app-approved
 * state, sends the user through auth-origin login, then resumes the PKCE mint.
 * A failed attempt remains bounded to one bounce per tab per five minutes.
 */
export function shouldAutoBridgeToSso(
  hostname: string = window.location.hostname,
  now: number = Date.now(),
): boolean {
  if (ssoBridgeRoleForHostname(hostname) !== "exchange") return false;
  if (isSsoLoggedOut()) return false;
  return shouldAttemptSsoBridge(now);
}

/**
 * Leave for the auth-origin mint leg: create + store the state nonce and PKCE
 * verifier, mark the attempt, and replace the location (the gate page is
 * transient — Back must not re-enter it). Resolves false when the bridge
 * cannot start (no nonce storage / unknown host); the caller falls back to
 * the ordinary login.
 */
export async function redirectToSsoBridge(
  returnTo: string,
  hostname: string = window.location.hostname,
): Promise<boolean> {
  const handshake = await createSsoBridgeHandshake();
  if (!handshake) return false;
  const url = buildBridgeMintUrl(
    hostname,
    handshake.state,
    handshake.challenge,
    returnTo,
  );
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
 * Dashboard side: trade the local session for a one-time code bound to the
 * app origin's PKCE challenge. The Bearer token comes from THIS origin's
 * localStorage — deliberately never from the parent-domain cookie, which JS
 * on user-content subdomains can plant (the server enforces the same rule).
 * No refresh token travels: the app origin already shares the HttpOnly
 * domain refresh cookie.
 */
export async function mintSsoCode(
  hostname: string,
  challenge: string,
  fetchFn: typeof fetch = fetch,
): Promise<SsoMintResult> {
  const base = apiBaseForHostname(hostname);
  if (!base) return { ok: false, error: "Host cannot mint SSO codes" };
  if (!isWellFormedSsoChallenge(challenge)) {
    return { ok: false, error: "Malformed code challenge" };
  }
  const token = readStoredStewardToken();
  if (!token) return { ok: false, error: "No local session" };
  try {
    const res = await fetchFn(`${base}/api/auth/sso-bridge/mint`, {
      method: "POST",
      credentials: "include",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ codeChallenge: challenge }),
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
 * App side: consume the code (presenting the PKCE verifier that never left
 * this origin's sessionStorage) and hydrate this origin's localStorage
 * mirror. After this the app origin is indistinguishable from one the user
 * logged into directly: same storage key, same `steward-token-sync` event,
 * and the existing AuthTokenSync loop takes over cookie sync + refresh (the
 * HttpOnly refresh cookie is domain-wide and already present).
 */
export async function performSsoExchange(
  code: string,
  verifier: string,
  hostname: string,
  fetchFn: typeof fetch = fetch,
): Promise<SsoExchangeResult> {
  const base = apiBaseForHostname(hostname);
  if (!base) return { ok: false, error: "Host cannot exchange SSO codes" };
  if (!isWellFormedSsoChallenge(verifier)) {
    return { ok: false, error: "Malformed code verifier" };
  }
  try {
    const res = await fetchFn(`${base}/api/auth/sso-bridge/exchange`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
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

    await writeStoredStewardToken(token);

    // Same call the login flow makes: sets the HttpOnly steward cookies + the
    // authed marker for this environment. It stays best-effort for an ordinary
    // bridge because AuthTokenSync retries. Account-link authority is never
    // discovered here: a pending Telegram claim remains inert until the user
    // returns to /get-started and confirms the preview explicitly.
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

/**
 * Destroy a code this origin refuses to exchange (state mismatch, missing
 * verifier). The server consumes atomically BEFORE checking the verifier, so
 * presenting the bare code burns it: without this, an abandoned handshake
 * leaves a live code sitting in the address bar and both origins' request
 * logs for the rest of its TTL. Fire-and-forget — the reply is always 401 and
 * failure to burn only restores the pre-existing exposure.
 */
export function burnSsoBridgeCode(
  code: string,
  hostname: string = window.location.hostname,
  fetchFn: typeof fetch = fetch,
): void {
  const base = apiBaseForHostname(hostname);
  if (!base || !isWellFormedSsoCode(code)) return;
  void fetchFn(`${base}/api/auth/sso-bridge/exchange`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  }).catch(() => {
    // error-policy:J6 best-effort destruction of an already-abandoned code;
    // the code still dies on its own 60s TTL.
  });
}

// ---------------------------------------------------------------------------
// Sign-out (defect fix: logout stays logged out)
// ---------------------------------------------------------------------------

/**
 * Explicit sign-out on ANY host of a bridge pair. The unified app's account
 * action routes hosted and public-auth sessions here because a local-only
 * sign-out that never reaches `/api/auth/logout` stamps no server logout
 * marker, and the paired origin's surviving session would silently undo it
 * (re-planting the domain cookies via its background session sync). Order
 * matters: the local logged-out marker lands synchronously first (auto-bridge
 * is suppressed even if the network never answers), the server logout request
 * is ISSUED while the session cookies are still in the jar (it ends the
 * server-side sessions AND stamps the server logout marker that blocks
 * minting, exchanging, and cookie re-planting for pre-logout tokens), and the
 * local scrub stays synchronous so the login page never renders over a
 * half-signed-out session. On hostnames outside the deployed map (local dev)
 * the server call is skipped and this degrades to the local scrub, exactly
 * the previous local behavior. The returned promise settles with the
 * server teardown; callers may ignore it.
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
  await clearStaleStewardSession();
  await serverLogout;
}
