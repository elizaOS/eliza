/**
 * Cloud SSO module.
 *
 * Implements the OAuth-style redirect / code-exchange flow against the
 * Eliza Cloud control plane. The local Milady instance is the Relying
 * Party; the cloud is the Authorization Server.
 *
 * Flow:
 *   1. UI hits `GET /api/auth/login/sso/start?returnTo=<path>`. The route
 *      calls {@link buildSsoStart} to mint a state nonce and build the
 *      authorize URL.
 *   2. Browser is 302-redirected to `${ELIZA_CLOUD_ISSUER}/oauth/authorize`.
 *   3. After the user approves, the cloud redirects back to
 *      `GET /api/auth/login/sso/callback?code=<code>&state=<state>`.
 *      The route calls {@link exchangeCodeForSession} which:
 *        - looks up the pending state, rejects on miss / expiry / mismatch
 *        - POSTs `code` to `${ELIZA_CLOUD_ISSUER}/oauth/token`
 *        - verifies the resulting `id_token` signature against the cached
 *          JWKS (RS256 only)
 *        - links / creates a local Identity for the cloud `sub`
 *        - mints a browser session.
 *
 * Hard rule: every error path is fail-closed. There is no `try { ... }
 * catch { return success }` shortcut. Any signature verify failure, any
 * state miss, any token endpoint non-2xx → rejected and audited.
 *
 * State storage is in-memory with a 10-minute TTL. The state map is
 * swept on each `consumePendingSsoState` call and on a periodic timer.
 * State is server-generated and verified on the callback so a forged
 * `state` cannot tunnel an attacker code through the user's session.
 */

import crypto from "node:crypto";
import { logger } from "@elizaos/core";
import type { RuntimeEnvRecord } from "@elizaos/shared";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { AuthStore } from "../../services/auth-store";
import {
  type JwksDocument,
  readCachedJwks,
  writeCachedJwks,
} from "../../services/cloud-jwks-store";
import { appendAuditEvent } from "./audit";

export const SSO_REDIRECT_PATH = "/api/auth/login/sso/callback";
export const SSO_STATE_TTL_MS = 10 * 60 * 1000;
export const SSO_TOKEN_ALG = "RS256";
const SSO_OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
const SSO_OAUTH_TOKEN_PATH = "/oauth/token";
const SSO_DEFAULT_SCOPE = "openid profile";

export type CloudSsoFailureReason =
  | "missing_issuer_env"
  | "missing_client_id_env"
  | "missing_state"
  | "state_invalid"
  | "state_expired"
  | "missing_code"
  | "token_exchange_failed"
  | "id_token_missing"
  | "id_token_invalid"
  | "id_token_alg_not_allowed"
  | "id_token_issuer_mismatch"
  | "id_token_audience_mismatch"
  | "id_token_subject_missing"
  | "jwks_fetch_failed"
  | "store_error";

export interface SsoStartResult {
  authorizeUrl: string;
  state: string;
  expiresAt: number;
}

export interface SsoExchangeContext {
  store: AuthStore;
  env?: RuntimeEnvRecord;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Used to build the absolute redirect URI (e.g. https://app.example or http://127.0.0.1:31337). */
  publicBaseUrl: string;
  /** IP / UA propagated to audit metadata. */
  ip?: string | null;
  userAgent?: string | null;
}

export interface SsoExchangeResult {
  ok: true;
  identityId: string;
  cloudUserId: string;
  cloudDisplayName: string;
  returnTo: string;
}

export interface SsoExchangeFailure {
  ok: false;
  reason: CloudSsoFailureReason;
}

interface SsoIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  iat: number;
  exp: number;
  name?: string;
  email?: string;
  [otherProperty: string]: unknown;
}

interface PendingSsoState {
  /** Plaintext state nonce (hex). Persisted only here, never in the DB. */
  state: string;
  /** Where the user wanted to land after login. */
  returnTo: string;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingSsoState>();

function trimTrailingSlash(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === input.length ? input : input.slice(0, end);
}

function readEnv(env: RuntimeEnvRecord, key: string): string | null {
  const v = env[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return "/";
  // Reject scheme-relative or external redirects.
  if (trimmed.startsWith("//")) return "/";
  return trimmed;
}

/**
 * Sweep expired state entries. Called whenever we touch the map.
 */
function sweepExpiredStates(now: number): void {
  for (const [k, v] of pendingStates) {
    if (now > v.expiresAt) pendingStates.delete(k);
  }
}

const sweepTimer = setInterval(
  () => {
    sweepExpiredStates(Date.now());
  },
  5 * 60 * 1000,
);
if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
  sweepTimer.unref();
}

/** Test-only reset hook. */
export function _resetSsoStateForTests(): void {
  pendingStates.clear();
}

function generateState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export interface SsoStartOptions {
  env?: RuntimeEnvRecord;
  /** Used to build the absolute redirect_uri. */
  publicBaseUrl: string;
  /** Caller-provided returnTo. Anything not starting with "/" is rewritten to "/". */
  returnTo?: string | null;
  now?: number;
}

/**
 * Build the cloud authorize URL and stash a server-generated `state` for
 * later verification. Returns the URL the caller should 302 to.
 *
 * Throws when `ELIZA_CLOUD_ISSUER` or `ELIZA_CLOUD_CLIENT_ID` is not
 * configured — the route handler should map this to a 503.
 */
export function buildSsoStart(options: SsoStartOptions): SsoStartResult {
  const env = options.env ?? process.env;
  const issuer = readEnv(env, "ELIZA_CLOUD_ISSUER");
  const clientId = readEnv(env, "ELIZA_CLOUD_CLIENT_ID");
  if (!issuer) {
    throw new SsoConfigError("missing_issuer_env");
  }
  if (!clientId) {
    throw new SsoConfigError("missing_client_id_env");
  }

  const now = options.now ?? Date.now();
  const state = generateState();
  const returnTo = safeReturnTo(options.returnTo);
  const expiresAt = now + SSO_STATE_TTL_MS;
  pendingStates.set(state, { state, returnTo, expiresAt });
  sweepExpiredStates(now);

  const redirectUri = `${trimTrailingSlash(options.publicBaseUrl)}${SSO_REDIRECT_PATH}`;
  const url = new URL(
    `${trimTrailingSlash(issuer)}${SSO_OAUTH_AUTHORIZE_PATH}`,
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SSO_DEFAULT_SCOPE);
  url.searchParams.set("state", state);

  return {
    authorizeUrl: url.toString(),
    state,
    expiresAt,
  };
}

/**
 * Configuration-failure thrown by {@link buildSsoStart}. Carries a
 * `reason` shaped to align with {@link CloudSsoFailureReason} so the
 * route handler can treat it uniformly with the runtime-failure path.
 */
export class SsoConfigError extends Error {
  constructor(public readonly reason: CloudSsoFailureReason) {
    super(`sso_config_error:${reason}`);
    this.name = "SsoConfigError";
  }
}

/**
 * Look up + atomically consume a pending state. Returns the recorded
 * `returnTo` on success, null on miss / expiry. The state slot is
 * deleted on lookup so a replay returns null.
 */
export function consumePendingSsoState(
  state: string | null | undefined,
  now: number = Date.now(),
): { returnTo: string } | null {
  if (typeof state !== "string" || state.length === 0) return null;
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (now > entry.expiresAt) return null;
  return { returnTo: entry.returnTo };
}

interface TokenResponseBody {
  id_token?: unknown;
  access_token?: unknown;
  token_type?: unknown;
}

async function loadJwks(
  issuer: string,
  options: SsoExchangeContext,
): Promise<JwksDocument | null> {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const cached = await readCachedJwks(issuer, { env, now });
  if (cached) return cached;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${trimTrailingSlash(issuer)}/.well-known/jwks.json`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") return null;
  const candidate = body as { keys?: unknown };
  if (!Array.isArray(candidate.keys)) return null;
  const document: JwksDocument = {
    keys: candidate.keys as JwksDocument["keys"],
  };
  await writeCachedJwks(issuer, document, { env, now });
  return document;
}

async function emitFailure(
  options: SsoExchangeContext,
  reason: CloudSsoFailureReason,
): Promise<void> {
  await appendAuditEvent(
    {
      actorIdentityId: null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      action: "auth.login.sso.callback",
      outcome: "failure",
      metadata: { reason },
    },
    { store: options.store, env: options.env },
  ).catch((err: unknown) => {
    logger.error("[auth-sso] audit emit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function emitSuccess(
  options: SsoExchangeContext,
  identityId: string,
  cloudUserId: string,
): Promise<void> {
  await appendAuditEvent(
    {
      actorIdentityId: identityId,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      action: "auth.login.sso.callback",
      outcome: "success",
      metadata: { cloudUserId },
    },
    { store: options.store, env: options.env },
  ).catch((err: unknown) => {
    logger.error("[auth-sso] audit emit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function deriveIdentityIdFromCloudUser(cloudUserId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(cloudUserId, "utf8")
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function audienceContainsClient(
  aud: string | string[],
  clientId: string,
): boolean {
  if (typeof aud === "string") return aud === clientId;
  return aud.some((a) => typeof a === "string" && a === clientId);
}

/**
 * Exchange `code` for a session.
 *
 * On success creates (or reuses) an Identity for the cloud `sub` and
 * returns the identityId — the route handler is responsible for minting
 * the session row + setting the cookie. We deliberately keep the session
 * mint out of this module so the same exchange logic is reusable from
 * tests without going through the cookie layer.
 */
export async function exchangeCodeForSession(
  input: {
    code: string;
    state: string;
  },
  options: SsoExchangeContext,
): Promise<SsoExchangeResult | SsoExchangeFailure> {
  const env = options.env ?? process.env;
  const issuer = readEnv(env, "ELIZA_CLOUD_ISSUER");
  const clientId = readEnv(env, "ELIZA_CLOUD_CLIENT_ID");
  const clientSecret = readEnv(env, "ELIZA_CLOUD_CLIENT_SECRET");
  if (!issuer) {
    await emitFailure(options, "missing_issuer_env");
    return { ok: false, reason: "missing_issuer_env" };
  }
  if (!clientId) {
    await emitFailure(options, "missing_client_id_env");
    return { ok: false, reason: "missing_client_id_env" };
  }

  if (typeof input.code !== "string" || input.code.length === 0) {
    await emitFailure(options, "missing_code");
    return { ok: false, reason: "missing_code" };
  }

  const now = options.now?.() ?? Date.now();
  const consumed = consumePendingSsoState(input.state, now);
  if (!consumed) {
    // Distinguish "never existed" vs "expired" in the audit metadata —
    // the route always returns 401 either way.
    await emitFailure(options, "state_invalid");
    return { ok: false, reason: "state_invalid" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenUrl = `${trimTrailingSlash(issuer)}${SSO_OAUTH_TOKEN_PATH}`;
  const redirectUri = `${trimTrailingSlash(options.publicBaseUrl)}${SSO_REDIRECT_PATH}`;

  const tokenForm = new URLSearchParams();
  tokenForm.set("grant_type", "authorization_code");
  tokenForm.set("code", input.code);
  tokenForm.set("redirect_uri", redirectUri);
  tokenForm.set("client_id", clientId);
  if (clientSecret) tokenForm.set("client_secret", clientSecret);

  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: tokenForm.toString(),
    });
  } catch {
    await emitFailure(options, "token_exchange_failed");
    return { ok: false, reason: "token_exchange_failed" };
  }
  if (!tokenResponse.ok) {
    await emitFailure(options, "token_exchange_failed");
    return { ok: false, reason: "token_exchange_failed" };
  }

  let tokenBody: TokenResponseBody;
  try {
    tokenBody = (await tokenResponse.json()) as TokenResponseBody;
  } catch {
    await emitFailure(options, "token_exchange_failed");
    return { ok: false, reason: "token_exchange_failed" };
  }

  const idToken = tokenBody.id_token;
  if (typeof idToken !== "string" || idToken.length === 0) {
    await emitFailure(options, "id_token_missing");
    return { ok: false, reason: "id_token_missing" };
  }

  let jwks: JwksDocument | null;
  try {
    jwks = await loadJwks(issuer, options);
  } catch {
    await emitFailure(options, "jwks_fetch_failed");
    return { ok: false, reason: "jwks_fetch_failed" };
  }
  if (!jwks || jwks.keys.length === 0) {
    await emitFailure(options, "jwks_fetch_failed");
    return { ok: false, reason: "jwks_fetch_failed" };
  }
  const localJwks = createLocalJWKSet({ keys: jwks.keys });

  let claims: SsoIdTokenClaims;
  try {
    const verified = await jwtVerify(idToken, localJwks, {
      algorithms: [SSO_TOKEN_ALG],
      issuer,
      audience: clientId,
    });
    if (!isStringRecord(verified.payload)) {
      await emitFailure(options, "id_token_invalid");
      return { ok: false, reason: "id_token_invalid" };
    }
    claims = verified.payload as unknown as SsoIdTokenClaims;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_JOSE_ALG_NOT_ALLOWED" || code === "ERR_JWS_INVALID") {
      await emitFailure(options, "id_token_alg_not_allowed");
      return { ok: false, reason: "id_token_alg_not_allowed" };
    }
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (err as { claim?: string }).claim;
      if (claim === "iss") {
        await emitFailure(options, "id_token_issuer_mismatch");
        return { ok: false, reason: "id_token_issuer_mismatch" };
      }
      if (claim === "aud") {
        await emitFailure(options, "id_token_audience_mismatch");
        return { ok: false, reason: "id_token_audience_mismatch" };
      }
    }
    await emitFailure(options, "id_token_invalid");
    return { ok: false, reason: "id_token_invalid" };
  }

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    await emitFailure(options, "id_token_subject_missing");
    return { ok: false, reason: "id_token_subject_missing" };
  }
  if (!audienceContainsClient(claims.aud, clientId)) {
    await emitFailure(options, "id_token_audience_mismatch");
    return { ok: false, reason: "id_token_audience_mismatch" };
  }

  const cloudUserId = claims.sub;
  const cloudDisplayName =
    (typeof claims.name === "string" && claims.name.length > 0
      ? claims.name
      : null) ??
    (typeof claims.email === "string" && claims.email.length > 0
      ? claims.email
      : null) ??
    `Cloud user ${cloudUserId.slice(0, 8)}`;

  let identityId: string;
  try {
    const existing = await options.store.findIdentityByCloudUserId(cloudUserId);
    if (existing) {
      identityId = existing.id;
    } else {
      identityId = deriveIdentityIdFromCloudUser(cloudUserId);
      const collide = await options.store.findIdentity(identityId);
      if (collide) {
        // Different cloudUserId hashed into the same id slot — vanishingly
        // unlikely, but treat as store error rather than silent collision.
        await emitFailure(options, "store_error");
        return { ok: false, reason: "store_error" };
      }
      await options.store.createIdentity({
        id: identityId,
        kind: "owner",
        displayName: cloudDisplayName,
        createdAt: now,
        passwordHash: null,
        cloudUserId,
      });
    }
  } catch (err) {
    logger.error("[auth-sso] identity link failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await emitFailure(options, "store_error");
    return { ok: false, reason: "store_error" };
  }

  await emitSuccess(options, identityId, cloudUserId);

  return {
    ok: true,
    identityId,
    cloudUserId,
    cloudDisplayName,
    returnTo: consumed.returnTo,
  };
}
