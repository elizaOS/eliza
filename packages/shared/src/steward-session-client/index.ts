/**
 * Shared Steward session client.
 *
 * Single source of truth for:
 *  - the storage / cookie / endpoint key names used across the unified
 *    frontend (`eliza.app`) and the cloud-api
 *    `/api/auth/steward-session` route handler;
 *  - the request / response / error shapes the route exchanges with the
 *    browser;
 *  - the small set of helpers each consumer needs (sync, clear, read).
 *
 * Browser-only helpers return cleanly under SSR (`typeof window === "undefined"`).
 */

import { classifyElizaHostname } from "../elizacloud/domain-contract.js";
import { STEWARD_ACTIVE_SCOPE_KEY, STEWARD_TOKEN_KEY } from "./session-keys.js";
import {
  getStewardTabSessionAuthorityCoordinator,
  isStewardSessionAuthoritySuperseded,
  runStewardSessionAuthorityExclusive,
  type StewardSessionAuthorityKind,
  type StewardSessionAuthoritySnapshot,
  type StewardSessionAuthorityWorkContext,
} from "./tab-session-authority.js";
import { readCanonicalStewardToken } from "./token-reader.js";

export {
  STEWARD_ACTIVE_SCOPE_KEY,
  STEWARD_PENDING_WRITE_KEY,
  STEWARD_TOKEN_KEY,
} from "./session-keys.js";
export * from "./tab-session-authority.js";
export { registerStewardTokenReader } from "./token-reader.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Deployment scope paired with the Steward access token on a loopback-rendered
 * app. Hosted Cloud origins already isolate localStorage by origin; localhost
 * does not, so this companion key prevents a token minted for one configured
 * control plane from crossing into another after a local target switch.
 */
export const STEWARD_TOKEN_SCOPE_KEY = "steward_session_token_scope";

/** Typed browser event emitted after a canonical Steward token mutation. */
export const STEWARD_SESSION_CHANGE_EVENT = "steward-session-change";

export interface StewardSessionChangeDetail {
  state: "present" | "cleared";
  sessionEpoch: number;
}

let sessionEpoch = 0;

type StewardTokenRemoval = () => Promise<void>;
type StewardTokenPersistence = (
  token: string,
  revalidate: () => void,
  scope: StewardTokenScopePublication,
) => Promise<void>;

/** Metadata is part of the host's guarded write/rollback transaction. */
export interface StewardTokenScopePublication {
  /** Publish the host mirror synchronously after scope persistence and final authority validation. */
  commit(publishToken: () => void): void;
  rollback(): void;
}

let stewardTokenRemoval: StewardTokenRemoval | null = null;
let stewardTokenPersistence: StewardTokenPersistence | null = null;

/**
 * An explicit context is required for nested work. Borrowing an ambient async
 * transaction could let an unrelated callback bypass the origin-wide lock.
 */
export interface StewardTokenMutationOptions {
  authority?: StewardSessionAuthorityWorkContext;
  expected?: StewardSessionAuthoritySnapshot;
  signal?: AbortSignal;
}

export interface StewardTokenWriteOptions extends StewardTokenMutationOptions {
  /** Synchronous caller-owned target check at the final guarded publication. */
  beforePublish?: () => void;
}

function serializeStewardTokenMutation<T>(
  operation: (ctx: StewardSessionAuthorityWorkContext) => Promise<T>,
  kind: StewardSessionAuthorityKind = "token-write",
  options: StewardTokenMutationOptions = {},
): Promise<T> {
  const run =
    options.authority?.runExclusive ?? runStewardSessionAuthorityExclusive;
  return run({
    kind,
    signal: options.signal,
    ...(options.expected
      ? {
          expectedToken: options.expected.token,
          expectedGeneration: options.expected.generation,
          expectedScope: options.expected.scope,
        }
      : {}),
    work: operation,
  });
}

/** Distinguishes a failed durable token write from an ordinary auth failure. */
export class StewardTokenPersistenceError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Could not persist the protected Steward token",
      { cause },
    );
    this.name = "StewardTokenPersistenceError";
  }
}

/** Distinguishes a failed canonical token removal from legacy-key cleanup. */
export class StewardTokenRemovalError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Could not remove the protected Steward token",
      { cause },
    );
    this.name = "StewardTokenRemovalError";
  }
}

/** Publish a credential-domain-specific transition without exposing the token. */
export function dispatchStewardSessionChange(
  state: StewardSessionChangeDetail["state"],
): void {
  if (typeof window === "undefined") return;
  sessionEpoch += 1;
  window.dispatchEvent(
    new CustomEvent<StewardSessionChangeDetail>(STEWARD_SESSION_CHANGE_EVENT, {
      detail: { state, sessionEpoch },
    }),
  );
}

/**
 * Installs the host-owned durable removal boundary for the Steward token.
 * Browser-only consumers fall back to localStorage; native shells register
 * their awaited secure-store implementation while the storage bridge is live.
 */
export function registerStewardTokenRemoval(
  removal: StewardTokenRemoval,
): () => void {
  stewardTokenRemoval = removal;
  return () => {
    if (stewardTokenRemoval === removal) stewardTokenRemoval = null;
  };
}

/**
 * Installs the host-owned durable persistence boundary for the Steward token.
 * Native shells register an awaited secure-store write plus exact readback;
 * browser-only consumers retain the localStorage fallback.
 */
export function registerStewardTokenPersistence(
  persistence: StewardTokenPersistence,
): () => void {
  stewardTokenPersistence = persistence;
  return () => {
    if (stewardTokenPersistence === persistence) {
      stewardTokenPersistence = null;
    }
  };
}

/**
 * localStorage key for the Steward refresh token.
 *
 * Refresh tokens are persisted only as the HttpOnly `steward-refresh-token`
 * cookie (set by `/api/auth/steward-session` and
 * `/api/auth/steward-nonce-exchange`). This key is retained solely so
 * `clearStoredStewardToken()` can drain the stale localStorage value left in
 * tabs opened before the cookie-only rollout. Do NOT read or write it.
 */
export const STEWARD_REFRESH_TOKEN_KEY = "steward_refresh_token";

/** Non-HttpOnly cookie set to "1" while the server-side session is live. */
export const STEWARD_AUTHED_COOKIE = "steward-authed";

/** Steward multi-tenant identifier for Eliza Cloud. */
export const STEWARD_TENANT_ID = "elizacloud";

/** Same-origin endpoint that exchanges the JWT for HttpOnly cookies. */
export const STEWARD_SESSION_ENDPOINT = "/api/auth/steward-session";

/**
 * Same-origin endpoint that swaps a one-time OAuth `code` (the nonce-exchange
 * flow's `?code=` query param) for HttpOnly cookies. The endpoint calls
 * Steward's `POST /auth/oauth/exchange` server-side so the access and refresh
 * tokens never touch the browser URL.
 */
export const STEWARD_NONCE_EXCHANGE_ENDPOINT =
  "/api/auth/steward-nonce-exchange";

/**
 * Same-origin endpoint that rotates the Steward access + refresh tokens
 * using the HttpOnly `steward-refresh-token` cookie. The browser POSTs
 * with `credentials: "include"`; the cookie travels automatically. Trusted
 * Cloud browser origins receive the short-lived access token so the SPA can
 * refresh its localStorage mirror while route auth remains synchronous.
 */
export const STEWARD_REFRESH_ENDPOINT = "/api/auth/steward-refresh";

/**
 * Custom CSRF marker header required by the cloud-api cookie-authenticated
 * auth mutations. Presence alone is the contract: a cross-origin "simple
 * request" cannot set custom headers, so any request carrying it either
 * survived a preflight or never needed one (same-origin / non-browser).
 */
export const STEWARD_CSRF_HEADER = "x-eliza-csrf";
export const STEWARD_CSRF_HEADER_VALUE = "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StewardSessionRequest {
  token: string;
  refreshToken?: string | null;
  /** Phone independently re-verified by the Cloud API against this bearer. */
  verifiedPhone?: string;
}

export interface StewardTelegramClaimConfirmationRequest
  extends StewardSessionRequest {
  /** Opaque Telegram DM continuation that names an existing rowless account. */
  telegramContinuation: string;
  /** Explicit confirmation ceremony marker; ordinary login sync never sends it. */
  telegramClaimConfirmation: "explicit";
}

const TELEGRAM_ACCOUNT_CLAIM_PATTERN = /^[a-zA-Z0-9:+_-]{8,180}$/;

/**
 * Accepts only opaque browser credentials. Platform-scoped ids are derived
 * from guessable messaging ids and must remain inside trusted gateways.
 */
export function sanitizeTelegramAccountClaimContinuation(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !TELEGRAM_ACCOUNT_CLAIM_PATTERN.test(trimmed) ||
    trimmed.startsWith("platform:")
  ) {
    return null;
  }
  return trimmed;
}

export interface StewardSessionResponse {
  ok: true;
  userId: string;
  stewardUserId: string;
  initialCreditsGranted?: boolean;
  initialFreeCreditsUsd?: number;
  welcomeBonusWithheld?: boolean;
  // Mirrors `SignupGrantWithheldReason` in
  // packages/cloud/shared/src/lib/services/signup-grant-guard.ts (the source of
  // truth). Kept as an inline literal union because `packages/shared` cannot
  // depend on `packages/cloud/shared`; keep in sync when reasons are added.
  welcomeBonusWithheldReason?: "ip_daily_cap" | "count_unavailable";
  welcomeBonusWithheldMessage?: string;
}

/**
 * Distinct outcomes the cloud-api route returns. The client uses these to
 * decide whether to wipe localStorage (`invalid_token`) or hold steady
 * (`server_secret_missing`).
 */
export type StewardSessionErrorCode =
  | "missing_token"
  | "invalid_token"
  /** The user explicitly logged out AFTER this token was issued (cross-host
   * SSO logout marker). A real revocation: clients clear the stored session
   * instead of retrying the sync. */
  | "session_ended"
  /** The SSO logout-marker store is unreachable and the token is
   * bridge-issued, so the sync fails closed (503). Transient: clients hold
   * the stored session and retry, as with `server_secret_missing`. */
  | "sso_unavailable"
  | "server_secret_missing"
  | "steward_user_sync_failed"
  | "verified_phone_invalid"
  | "verified_phone_mismatch"
  | "verified_phone_conflict"
  | "telegram_claim_conflict"
  | "internal_error"
  // Nonce-exchange (response_type=code) outcomes. Surfaced both by the
  // cloud-api route and proxied through from Steward's /oauth/exchange.
  | "missing_code"
  | "code_invalid"
  | "code_expired"
  | "code_redirect_mismatch"
  | "code_tenant_mismatch"
  /** The exchange was attempted without the PKCE verifier. The hosted login
   * always starts the flow with a S256 challenge, so this is a planted or
   * pre-PKCE callback — the client must restart sign-in. */
  | "missing_code_verifier"
  | "steward_upstream_unavailable"
  /** The request carried no non-simple-request marker (custom X-Eliza-CSRF
   * header or JSON content type), so it could have been a cross-origin
   * simple request. Rejected before any cookie was read. */
  | "csrf_marker_required"
  | "forbidden_origin";

export class StewardSessionError extends Error {
  readonly status: number;
  readonly code: StewardSessionErrorCode | string | null;

  constructor(
    message: string,
    status: number,
    code: StewardSessionErrorCode | string | null,
  ) {
    super(message);
    this.name = "StewardSessionError";
    this.status = status;
    this.code = code;
  }
}

export interface StewardSessionNetworkOptions
  extends StewardTokenMutationOptions {
  /** Bound queue acquisition and the full response-body lifetime. */
  timeoutMs?: number;
}

export interface SyncOpts extends StewardSessionNetworkOptions {
  /**
   * Absolute or relative URL to POST to. Defaults to STEWARD_SESSION_ENDPOINT
   * (same-origin). Pass an absolute URL when crossing origins
   * (e.g. elizaos.ai -> api.eliza.app).
   */
  endpoint?: string;
  /**
   * Override the global fetch (mainly for tests and SSR shims).
   */
  fetchImpl?: typeof fetch;
}

export interface ClearOpts extends StewardSessionNetworkOptions {
  /** Endpoints to DELETE. Defaults to [STEWARD_SESSION_ENDPOINT]. */
  endpoints?: string[];
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function isLoopbackRenderedApp(): boolean {
  if (typeof window === "undefined") return false;
  const protocol = window.location?.protocol?.toLowerCase() ?? "";
  if (protocol !== "http:" && protocol !== "https:") return false;
  const hostname = window.location?.hostname?.toLowerCase() ?? "";
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  );
}

function stewardScopeForBase(configuredBase: string): string | null {
  try {
    const parsed = new URL(configuredBase);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const classified = classifyElizaHostname(parsed.hostname);
    if (classified.environment) {
      return `eliza-cloud:${classified.environment}`;
    }
    return `origin:${parsed.origin}`;
  } catch {
    return null;
  }
}

/**
 * Bind this loopback page to its launcher-selected Cloud control plane before
 * any auth reads. Hosted pages need no marker because browser origins already
 * isolate their storage. Invalid local targets publish a fail-closed sentinel.
 */
export function configureStoredStewardTokenScope(
  configuredBase: string | null | undefined,
): void {
  if (!isLoopbackRenderedApp()) return;
  const scope = configuredBase?.trim()
    ? stewardScopeForBase(configuredBase.trim())
    : null;
  window.localStorage.setItem(
    STEWARD_ACTIVE_SCOPE_KEY,
    scope ?? "invalid:unconfigured-cloud-target",
  );
}

function configuredLoopbackStewardScope(): string | null {
  if (!isLoopbackRenderedApp()) return null;
  return window.localStorage.getItem(STEWARD_ACTIVE_SCOPE_KEY);
}

/**
 * Reads the canonical access token. Returns `null` for SSR or a missing token;
 * storage access failures propagate so callers cannot mistake them for logout.
 */
export function readStoredStewardToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = readCanonicalStewardToken();
  if (!token) return null;
  const requiredScope = configuredLoopbackStewardScope();
  if (!requiredScope) return token;
  return window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY) === requiredScope
    ? token
    : null;
}

async function persistStoredStewardToken(
  token: string,
  requiredScope: string | null,
  ctx: StewardSessionAuthorityWorkContext,
  onPublished: () => void,
  beforePublish?: () => void,
): Promise<void> {
  try {
    const previousScope = window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY);
    let published = false;
    const scope: StewardTokenScopePublication = {
      commit: (publishToken) => {
        ctx.completeTokenWrite(token, () => {
          beforePublish?.();
          if (requiredScope) {
            window.localStorage.setItem(STEWARD_TOKEN_SCOPE_KEY, requiredScope);
            if (
              window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY) !==
              requiredScope
            ) {
              throw new Error("Steward token scope did not round-trip");
            }
          }
          publishToken();
        });
        published = true;
        onPublished();
      },
      rollback: () => {
        if (previousScope === null)
          window.localStorage.removeItem(STEWARD_TOKEN_SCOPE_KEY);
        else
          window.localStorage.setItem(STEWARD_TOKEN_SCOPE_KEY, previousScope);
        if (
          window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY) !== previousScope
        ) {
          throw new Error("Steward token scope rollback did not round-trip");
        }
      },
    };
    if (stewardTokenPersistence) {
      await stewardTokenPersistence(token, ctx.revalidate, scope);
      if (!published)
        throw new Error("Steward persistence did not publish token scope");
    } else {
      const previous = window.localStorage.getItem(STEWARD_TOKEN_KEY);
      try {
        ctx.revalidate();
        scope.commit(() => {
          window.localStorage.setItem(STEWARD_TOKEN_KEY, token);
          if (window.localStorage.getItem(STEWARD_TOKEN_KEY) !== token)
            throw new Error("Browser Steward token did not round-trip");
        });
      } catch (error) {
        // error-policy:J2 browser token and scope must not diverge on a failed commit.
        if (previous === null)
          window.localStorage.removeItem(STEWARD_TOKEN_KEY);
        else window.localStorage.setItem(STEWARD_TOKEN_KEY, previous);
        scope.rollback();
        throw error;
      }
    }
  } catch (error) {
    // error-policy:J2 callers must not publish authenticated state after a
    // failed durable write on a protected host.
    throw new StewardTokenPersistenceError(error);
  }
}

/**
 * Persists the canonical token and publishes authority only after the durable
 * host boundary succeeds. A protected-store rejection never becomes a
 * healthy-looking in-memory login that disappears on relaunch.
 */
export async function writeStoredStewardToken(
  token: string,
  options: StewardTokenWriteOptions = {},
): Promise<void> {
  if (typeof window === "undefined") return;
  await serializeStewardTokenMutation(
    async (ctx) => {
      const requiredScope = configuredLoopbackStewardScope();
      const wasCurrent =
        readCanonicalStewardToken() === token &&
        (!requiredScope ||
          window.localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY) ===
            requiredScope);
      if (!stewardTokenPersistence && wasCurrent) return;
      ctx.revalidate();
      await persistStoredStewardToken(
        token,
        requiredScope,
        ctx,
        () => {
          if (!wasCurrent) dispatchStewardSessionChange("present");
        },
        options.beforePublish,
      );
    },
    "token-write",
    options,
  );
}

/**
 * Replaces a token only while `expectedToken` still owns session authority.
 * The comparison, durable write, and event share the canonical mutation queue,
 * so a refresh response that arrives after logout cannot resurrect the session.
 */
export async function replaceStoredStewardTokenIfCurrent(
  expectedToken: string,
  token: string,
  options: StewardTokenWriteOptions = {},
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    return await serializeStewardTokenMutation(
      async (ctx) => {
        const current = readStoredStewardToken();
        if (current !== expectedToken) return false;
        ctx.revalidate();
        await persistStoredStewardToken(
          token,
          configuredLoopbackStewardScope(),
          ctx,
          () => {
            if (current !== token) dispatchStewardSessionChange("present");
          },
          options.beforePublish,
        );
        return true;
      },
      "token-write",
      options,
    );
  } catch (error) {
    if (isStewardSessionAuthoritySuperseded(error)) return false;
    throw error;
  }
}

/**
 * Clears canonical authority before draining the obsolete refresh-token key.
 * Once the canonical removal succeeds, invalidation is published even if the
 * legacy cleanup fails; either storage failure remains observable to callers.
 */
export async function clearStoredStewardToken(
  options: StewardTokenMutationOptions = {},
): Promise<void> {
  if (typeof window === "undefined") return;
  await serializeStewardTokenMutation(
    async (ctx) => {
      ctx.revalidate();
      // Never clear/reset this generation when a new login starts (ABA).
      ctx.advanceLogoutGeneration();
      try {
        if (stewardTokenRemoval) {
          await stewardTokenRemoval();
        } else {
          window.localStorage.removeItem(STEWARD_TOKEN_KEY);
        }
      } catch (error) {
        // error-policy:J2 callers must distinguish canonical removal failure from
        // obsolete refresh-key cleanup so they never publish a false logout.
        throw new StewardTokenRemovalError(error);
      }
      ctx.noteToken(null);
      ctx.revalidate();
      dispatchStewardSessionChange("cleared");
      window.localStorage.removeItem(STEWARD_TOKEN_SCOPE_KEY);
      window.localStorage.removeItem(STEWARD_REFRESH_TOKEN_KEY);
    },
    "logout",
    options,
  );
}

/**
 * Returns true when the non-HttpOnly `steward-authed=1` marker cookie is
 * present. The JWT cookie itself is HttpOnly, so JS uses this hint to know
 * "there is a server session" without ever touching the token.
 */
export function stewardAuthedCookieName(environment?: string | null): string {
  const env = environment?.trim();
  if (!env || env === "production") return STEWARD_AUTHED_COOKIE;
  return `${STEWARD_AUTHED_COOKIE}-${env}`;
}

function inferStewardCookieEnvironment(): string | null {
  if (typeof window === "undefined") return null;
  const hostname = window.location.hostname.toLowerCase();
  if (
    hostname === "staging.eliza.app" ||
    hostname === "cloud-staging.eliza.app" ||
    hostname === "api-staging.eliza.app" ||
    hostname === "staging.elizacloud.ai" ||
    hostname === "app-staging.elizacloud.ai" ||
    hostname === "api-staging.elizacloud.ai"
  ) {
    return "staging";
  }
  if (
    hostname === "dev.elizacloud.ai" ||
    hostname === "app-dev.elizacloud.ai" ||
    hostname === "api-dev.elizacloud.ai"
  ) {
    return "dev";
  }
  return null;
}

export function hasStewardAuthedCookie(environment?: string | null): boolean {
  if (typeof document === "undefined") return false;
  const cookieName = stewardAuthedCookieName(
    environment ?? inferStewardCookieEnvironment(),
  );
  return document.cookie
    .split(";")
    .some((part) => part.trim().startsWith(`${cookieName}=1`));
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function readErrorBody(
  response: Response,
): Promise<{ error?: string; code?: string } | null> {
  try {
    return (await response.json()) as { error?: string; code?: string };
  } catch {
    // error-policy:J3 malformed server errors remain explicitly unavailable.
    return null;
  }
}

function withSessionNetworkAuthority<T>(
  kind: StewardSessionAuthorityKind,
  opts: StewardSessionNetworkOptions,
  work: (authority: StewardSessionAuthorityWorkContext) => Promise<T>,
): Promise<T> {
  const coordinator = getStewardTabSessionAuthorityCoordinator();
  const expected =
    opts.expected ?? opts.authority?.revalidate() ?? coordinator.readSnapshot();
  const run = opts.authority?.runExclusive ?? coordinator.runExclusive;
  return run({
    kind,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    expectedToken: expected.token,
    expectedGeneration: expected.generation,
    expectedScope: expected.scope,
    ...(kind === "cookie-delete" ? { requireTokenAbsent: true } : {}),
    work,
  });
}

/**
 * POSTs the Steward JWT (+ optional refresh token) to the session endpoint
 * so the server can set HttpOnly cookies. Throws `StewardSessionError` on
 * non-2xx; caller decides whether to wipe localStorage based on `error.code`.
 */
export async function syncStewardSession(
  token: string,
  refreshToken?: string | null,
  opts: SyncOpts = {},
): Promise<StewardSessionResponse> {
  const endpoint = opts.endpoint ?? STEWARD_SESSION_ENDPOINT;
  const f = opts.fetchImpl ?? fetch;
  // Refresh tokens now live exclusively in the HttpOnly
  // `steward-refresh-token` cookie. We forward whatever the caller passes
  // (e.g. the value still arriving in a legacy URL fragment during the
  // rollout window) so the server can set the cookie on first login, but we
  // do NOT read it back from localStorage — that path is being removed.
  const body: StewardSessionRequest = {
    token,
    ...(refreshToken ? { refreshToken } : {}),
  };
  return withSessionNetworkAuthority(
    "session-sync",
    opts,
    async (authority) => {
      authority.revalidate();
      const response = await f(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          [STEWARD_CSRF_HEADER]: STEWARD_CSRF_HEADER_VALUE,
        },
        body: JSON.stringify(body),
        signal: authority.signal,
      });
      authority.revalidate();
      if (!response.ok) {
        const errBody = await readErrorBody(response);
        authority.revalidate();
        throw new StewardSessionError(
          errBody?.error || "Could not establish an Eliza Cloud session.",
          response.status,
          errBody?.code ?? null,
        );
      }
      const result = (await response.json()) as StewardSessionResponse;
      authority.revalidate();
      return result;
    },
  );
}

// ---------------------------------------------------------------------------
// Nonce-exchange (response_type=code) flow
// ---------------------------------------------------------------------------

export interface StewardNonceExchangeRequest {
  /** One-time code from the Steward redirect (`?code=`). */
  code: string;
  /**
   * The `redirect_uri` that was sent to Steward `/authorize`. Steward verifies
   * this matches what was issued. If omitted, the cloud-api route falls back
   * to the value provided server-side via env / convention; in practice the
   * caller should send the same redirect_uri it used originally.
   */
  redirectUri?: string;
  /** Steward tenant ID (e.g. "elizacloud"). */
  tenantId?: string;
  /** PKCE verifier paired with the `code_challenge` sent to Steward. */
  codeVerifier?: string;
}

export interface StewardNonceExchangeResponse extends StewardSessionResponse {
  expiresIn?: number;
  expiresAt?: number;
  /**
   * Steward JWT. Mirrored from the upstream Steward exchange so the SPA can
   * write it to localStorage (required by `@elizaos/ui`'s `useAuth()` to
   * report `isAuthenticated=true`). HttpOnly cookies are still the canonical
   * session — this is the JS-readable copy that keeps the wallet and OAuth
   * paths symmetric. The long-lived refresh token is deliberately NOT
   * mirrored; it stays in the HttpOnly cookie.
   */
  token?: string;
}

export interface ExchangeStewardCodeOpts extends SyncOpts {
  /** redirect_uri that was sent to /authorize (must match exactly). */
  redirectUri?: string;
  /** Steward tenant id. */
  tenantId?: string;
  /** PKCE verifier paired with the `code_challenge` sent to Steward. */
  codeVerifier?: string;
}

/**
 * POSTs the one-time OAuth code to the cloud-api nonce-exchange endpoint.
 * The route calls Steward `POST /auth/oauth/exchange` server-side, sets the
 * HttpOnly steward-token + steward-refresh-token cookies, and returns the
 * Eliza Cloud user id. Some cross-origin checkout callers may also receive a
 * browser bearer token. Throws `StewardSessionError` on non-2xx.
 */
export async function exchangeStewardCode(
  code: string,
  opts: ExchangeStewardCodeOpts = {},
): Promise<StewardNonceExchangeResponse> {
  const endpoint = opts.endpoint ?? STEWARD_NONCE_EXCHANGE_ENDPOINT;
  const f = opts.fetchImpl ?? fetch;
  const body: StewardNonceExchangeRequest = {
    code,
    ...(opts.redirectUri ? { redirectUri: opts.redirectUri } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.codeVerifier ? { codeVerifier: opts.codeVerifier } : {}),
  };
  return withSessionNetworkAuthority(
    "nonce-exchange",
    opts,
    async (authority) => {
      authority.revalidate();
      const response = await f(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          [STEWARD_CSRF_HEADER]: STEWARD_CSRF_HEADER_VALUE,
        },
        body: JSON.stringify(body),
        signal: authority.signal,
      });
      authority.revalidate();
      if (!response.ok) {
        const errBody = await readErrorBody(response);
        authority.revalidate();
        throw new StewardSessionError(
          errBody?.error || "Could not complete Eliza Cloud sign-in.",
          response.status,
          errBody?.code ?? null,
        );
      }
      const result = (await response.json()) as StewardNonceExchangeResponse;
      authority.revalidate();
      return result;
    },
  );
}

export {
  buildStewardOAuthAuthorizeUrl,
  consumeStewardOAuthAttempt,
  consumeStewardPkceVerifier,
  createStewardOAuthAuthorityBinding,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardOAuthState,
  generateStewardPkceVerifier,
  peekStewardOAuthState,
  type StewardOAuthAuthorityBinding,
  type StewardOAuthProvider,
  type StewardPkcePair,
  storeStewardPkceVerifier,
} from "./steward-oauth-pkce.js";

/**
 * Delete cookies only after canonical authority is absent. Callers must await
 * completion and handle failures; a later login cannot overtake held cleanup.
 * This does not itself end an identity session or remove a stored token.
 */
export async function clearStewardSession(opts: ClearOpts = {}): Promise<void> {
  const endpoints = opts.endpoints ?? [STEWARD_SESSION_ENDPOINT];
  const f = opts.fetchImpl ?? fetch;
  return withSessionNetworkAuthority(
    "cookie-delete",
    opts,
    async (authority) => {
      for (const url of endpoints) {
        authority.revalidate();
        const response = await f(url, {
          method: "DELETE",
          credentials: "include",
          headers: { [STEWARD_CSRF_HEADER]: STEWARD_CSRF_HEADER_VALUE },
          signal: authority.signal,
        });
        authority.revalidate();
        if (!response.ok) {
          const errBody = await readErrorBody(response);
          authority.revalidate();
          throw new StewardSessionError(
            errBody?.error || "Could not clear the Eliza Cloud session cookie.",
            response.status,
            errBody?.code ?? null,
          );
        }
      }
    },
  );
}
