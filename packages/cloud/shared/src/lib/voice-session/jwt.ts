/**
 * Voice-session scoped JWT: mint, verify, and per-`jti` revocation.
 *
 * The realtime voice WebSocket cannot set an `Authorization` header (WebView
 * 113 on the Light Phone III drops custom headers on `new WebSocket()`), so the
 * client presents this token in the first `hello` frame instead. That makes the
 * token the ONLY thing standing between an anonymous socket and a paid provider
 * stream, so it is deliberately narrow:
 *
 *   - short TTL (<=120s) — it is a bootstrap credential, not a session lease;
 *   - single org + single agent + single conversation claims — a stolen token
 *     cannot be replayed against a different tenant/agent/conversation;
 *   - `aud="voice-session"` — it is rejected by every other audience;
 *   - `jti` — a single token can be revoked before natural expiry (SEC-6/SEC-9),
 *     which is what makes revoke-to-silence enforceable.
 *
 * Signing reuses the existing cloud JWKS signing key (`getPrivateKey` /
 * `getPublicKey` from `auth/jwks`), so the published `/.well-known/jwks.json`
 * already carries the verification key — no new key material, no new rotation
 * surface. Revocation reuses the same Redis-backed denylist pattern as the
 * internal-JWT denylist, fail-closed when Redis is configured.
 */

import { jwtVerify, SignJWT } from "jose";
import {
  getAlgorithm,
  getKeyId,
  getPrivateKey,
  getPublicKey,
  isJWKSConfigured,
} from "../auth/jwks";
import {
  buildRedisClient,
  type CompatibleRedis,
  hasRedisConfig,
  isCloudflareWorkerRuntime,
} from "../cache/redis-factory";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";

/** Audience claim — a voice-session token is valid ONLY for the voice WS. */
export const VOICE_SESSION_JWT_AUDIENCE = "voice-session";
/** Issuer claim — matches the rest of the cloud JWT surface. */
export const VOICE_SESSION_JWT_ISSUER = "eliza-cloud";
/** Hard TTL ceiling. The contract pins <=120s; we never mint longer. */
export const VOICE_SESSION_JWT_MAX_TTL_SECONDS = 120;
/** Floor so a clock-skew or a 0 never produces an already-dead token. */
export const VOICE_SESSION_JWT_MIN_TTL_SECONDS = 15;
/** Default TTL when a caller does not specify one. */
export const VOICE_SESSION_JWT_DEFAULT_TTL_SECONDS = 120;
/** Clock-skew tolerance applied on verify (`nbf`/`exp`). */
export const VOICE_SESSION_JWT_CLOCK_SKEW_SECONDS = 5;

const REVOCATION_KEY_PREFIX = "voice-session:revoked:";
/** No voice-session token lives past the TTL ceiling; cap the denylist TTL. */
const MAX_REVOCATION_TTL_SECONDS = VOICE_SESSION_JWT_MAX_TTL_SECONDS + 30;
const ENV_PREFIX = process.env.ENVIRONMENT || "local";

export interface VoiceSessionTokenClaims {
  /** The session this token authorizes exactly one WS connection for. */
  sessionId: string;
  /** Owning organization — tenant isolation boundary. */
  organizationId: string;
  /** Authenticated user who minted the session. */
  userId: string;
  /** Single agent this session may talk to. */
  agentId: string;
  /** Single conversation this session may write turns into. */
  conversationId: string;
}

export interface VoiceSessionTokenMintInput extends VoiceSessionTokenClaims {
  /** Requested TTL in seconds; clamped to [MIN, MAX]. */
  ttlSeconds?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface VoiceSessionTokenMintResult {
  token: string;
  /** JWT id — hand this to the revocation store on disconnect/complete. */
  jti: string;
  /** ISO-8601 absolute expiry. */
  expiresAt: string;
  /** Unix-seconds expiry (matches the `exp` claim). */
  expSeconds: number;
}

export interface VoiceSessionTokenVerifyResult {
  claims: VoiceSessionTokenClaims;
  jti: string;
  /** Unix-seconds expiry from the verified `exp` claim. */
  expSeconds: number;
}

export class VoiceSessionTokenError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "invalid_input"
      | "invalid_token"
      | "revoked"
      | "claim_mismatch",
  ) {
    super(message);
    this.name = "VoiceSessionTokenError";
  }
}

export function isVoiceSessionJwtConfigured(): boolean {
  return isJWKSConfigured();
}

function clampTtl(ttlSeconds: number | undefined): number {
  const requested =
    typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)
      ? Math.floor(ttlSeconds)
      : VOICE_SESSION_JWT_DEFAULT_TTL_SECONDS;
  return Math.min(
    Math.max(requested, VOICE_SESSION_JWT_MIN_TTL_SECONDS),
    VOICE_SESSION_JWT_MAX_TTL_SECONDS,
  );
}

function assertNonEmpty(field: keyof VoiceSessionTokenClaims, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VoiceSessionTokenError(`voice-session ${field} is required`, "invalid_input");
  }
}

function assertClaims(claims: VoiceSessionTokenClaims): void {
  assertNonEmpty("sessionId", claims.sessionId);
  assertNonEmpty("organizationId", claims.organizationId);
  assertNonEmpty("userId", claims.userId);
  assertNonEmpty("agentId", claims.agentId);
  assertNonEmpty("conversationId", claims.conversationId);
}

/**
 * Mint a scoped voice-session token. The `jti` is a random nonce so a single
 * token can be revoked without disturbing any other session.
 */
export async function mintVoiceSessionToken(
  input: VoiceSessionTokenMintInput,
): Promise<VoiceSessionTokenMintResult> {
  if (!isVoiceSessionJwtConfigured()) {
    throw new VoiceSessionTokenError(
      "voice-session JWT signing key (JWT_SIGNING_*) is not configured",
      "not_configured",
    );
  }
  assertClaims(input);

  const now = input.now ?? Date.now;
  const nowSeconds = Math.floor(now() / 1000);
  const ttl = clampTtl(input.ttlSeconds);
  const expSeconds = nowSeconds + ttl;
  const jti = crypto.randomUUID();

  const privateKey = await getPrivateKey();
  const token = await new SignJWT({
    sessionId: input.sessionId,
    organizationId: input.organizationId,
    userId: input.userId,
    agentId: input.agentId,
    conversationId: input.conversationId,
  })
    .setProtectedHeader({ alg: getAlgorithm(), kid: getKeyId() })
    .setIssuer(VOICE_SESSION_JWT_ISSUER)
    .setAudience(VOICE_SESSION_JWT_AUDIENCE)
    .setSubject(input.userId)
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(expSeconds)
    .setJti(jti)
    .sign(privateKey);

  return {
    token,
    jti,
    expSeconds,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
  };
}

function readClaim(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new VoiceSessionTokenError(
      `voice-session token is missing required claim: ${key}`,
      "invalid_token",
    );
  }
  return value;
}

/**
 * Verify a voice-session token presented in a `hello` frame.
 *
 * Checks, in order: signature + `aud`/`iss`/`exp`/`nbf` (via `jwtVerify`), then
 * the `jti` revocation denylist (fail-closed when configured). When
 * `expected` claims are supplied, every scoped claim MUST match exactly —
 * this is the SEC boundary that stops a token minted for one
 * org/agent/conversation from opening a socket for another.
 */
export async function verifyVoiceSessionToken(
  token: string,
  expected?: Partial<VoiceSessionTokenClaims>,
  options?: { now?: () => number },
): Promise<VoiceSessionTokenVerifyResult> {
  if (!isVoiceSessionJwtConfigured()) {
    throw new VoiceSessionTokenError(
      "voice-session JWT verification key is not configured",
      "not_configured",
    );
  }
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new VoiceSessionTokenError("voice-session token is malformed", "invalid_token");
  }

  const publicKey = await getPublicKey();
  let payload: Record<string, unknown>;
  let jti: string;
  let expSeconds: number;
  try {
    const currentDate = options?.now ? new Date(options.now()) : undefined;
    const verified = await jwtVerify(token, publicKey, {
      issuer: VOICE_SESSION_JWT_ISSUER,
      audience: VOICE_SESSION_JWT_AUDIENCE,
      algorithms: [getAlgorithm()],
      clockTolerance: VOICE_SESSION_JWT_CLOCK_SKEW_SECONDS,
      ...(currentDate ? { currentDate } : {}),
    });
    payload = verified.payload as Record<string, unknown>;
    if (typeof payload.jti !== "string" || payload.jti.trim() === "") {
      throw new VoiceSessionTokenError("voice-session token is missing jti", "invalid_token");
    }
    if (typeof payload.exp !== "number") {
      throw new VoiceSessionTokenError("voice-session token is missing exp", "invalid_token");
    }
    jti = payload.jti;
    expSeconds = payload.exp;
  } catch (error) {
    if (error instanceof VoiceSessionTokenError) throw error;
    throw new VoiceSessionTokenError(
      `voice-session token verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "invalid_token",
    );
  }

  const claims: VoiceSessionTokenClaims = {
    sessionId: readClaim(payload, "sessionId"),
    organizationId: readClaim(payload, "organizationId"),
    userId: readClaim(payload, "userId"),
    agentId: readClaim(payload, "agentId"),
    conversationId: readClaim(payload, "conversationId"),
  };

  if (expected) {
    for (const key of Object.keys(expected) as (keyof VoiceSessionTokenClaims)[]) {
      const want = expected[key];
      if (want !== undefined && claims[key] !== want) {
        throw new VoiceSessionTokenError(
          `voice-session token ${key} claim does not match the requested session`,
          "claim_mismatch",
        );
      }
    }
  }

  if (await isVoiceSessionTokenRevoked(jti)) {
    throw new VoiceSessionTokenError("voice-session token has been revoked", "revoked");
  }

  return { claims, jti, expSeconds };
}

// ---------------------------------------------------------------------------
// Revocation store (per-`jti`), mirroring the internal-JWT denylist contract.
// ---------------------------------------------------------------------------

let cachedRedis: CompatibleRedis | null = null;
let testRedisOverride: CompatibleRedis | null = null;

function getRedis(): CompatibleRedis | null {
  if (testRedisOverride) return testRedisOverride;
  if (!isCloudflareWorkerRuntime() && cachedRedis) return cachedRedis;
  // On Workers, Redis credentials are on `c.env` (via getCloudAwareEnv), not
  // plain process.env, so the session directory + revocation store resolve in
  // production instead of silently reporting "not configured".
  const client = buildRedisClient(getCloudAwareEnv());
  if (client && !isCloudflareWorkerRuntime()) cachedRedis = client;
  return client;
}

/**
 * Test-only: inject a fake revocation store so the revoke->verify contract can
 * be exercised without a live Redis. Pass null to clear.
 */
export function __setVoiceSessionRevocationStoreForTests(store: CompatibleRedis | null): void {
  testRedisOverride = store;
}

function revocationKey(jti: string): string {
  return `${ENV_PREFIX}:${REVOCATION_KEY_PREFIX}${jti}`;
}

/**
 * True when a Redis backend is configured and per-`jti` revocation is therefore
 * durable across workers. When false, revocation relies on the short TTL only.
 */
export function isVoiceSessionRevocationConfigured(): boolean {
  return hasRedisConfig(getCloudAwareEnv());
}

/**
 * Add a `jti` to the short-TTL revocation store. TTL defaults to the token
 * ceiling so the entry self-cleans once the token would have expired anyway.
 */
export async function revokeVoiceSessionToken(jti: string, expSeconds?: number): Promise<void> {
  if (typeof jti !== "string" || jti.trim() === "") {
    throw new VoiceSessionTokenError("cannot revoke an empty jti", "invalid_input");
  }
  const redis = getRedis();
  if (!redis) {
    // No durable store: the token still dies at its <=120s TTL. Callers that
    // require same-window single-token revocation MUST configure Redis; we do
    // not silently claim success on a mechanism that does not exist.
    logger.warn("[voice-session-jwt] revocation store not configured; relying on token TTL only");
    return;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const remaining =
    typeof expSeconds === "number" && Number.isFinite(expSeconds)
      ? Math.ceil(expSeconds - nowSeconds)
      : MAX_REVOCATION_TTL_SECONDS;
  const ttl = Math.min(Math.max(remaining, 1), MAX_REVOCATION_TTL_SECONDS);
  await redis.set(revocationKey(jti), "1", { ex: ttl });
}

/**
 * Fail-closed revocation check: when a store is configured but errors, the
 * token is treated as revoked (never `catch -> allow`). When no store is
 * configured, revocation is genuinely unsupported and this returns false.
 */
export async function isVoiceSessionTokenRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const value = await redis.get(revocationKey(jti));
    return value !== null && value !== undefined;
  } catch (error) {
    logger.error(
      `[voice-session-jwt] revocation check failed (fail-closed): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}

/** Test-only: drop the cached Redis client so a fresh env is observed. */
export function __resetVoiceSessionRevocationClientForTests(): void {
  cachedRedis = null;
  testRedisOverride = null;
}

// ---------------------------------------------------------------------------
// Session directory: sessionId -> jti, so a revoke that lands on a DIFFERENT
// worker than the live socket can still durably revoke the token by jti
// (SEC-6 cross-worker). The live socket's revocation poll then severs it.
// ---------------------------------------------------------------------------

const SESSION_DIR_KEY_PREFIX = "voice-session:dir:";

// The directory key is scoped to BOTH org and user so a revoke can only resolve
// a session the SAME user owns — a same-org peer who learns a sessionId cannot
// resolve (and therefore cannot revoke) another user's session.
function sessionDirKey(organizationId: string, userId: string, sessionId: string): string {
  return `${ENV_PREFIX}:${SESSION_DIR_KEY_PREFIX}${organizationId}:${userId}:${sessionId}`;
}

/** Record the sessionId->jti binding at mint (TTL = token lifetime + slack). */
export async function recordVoiceSessionJti(input: {
  organizationId: string;
  userId: string;
  sessionId: string;
  jti: string;
  expSeconds: number;
}): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    Math.max(Math.ceil(input.expSeconds - nowSeconds), 1),
    MAX_REVOCATION_TTL_SECONDS,
  );
  await redis.set(sessionDirKey(input.organizationId, input.userId, input.sessionId), input.jti, {
    ex: ttl,
  });
}

/**
 * Look up the jti for a session, scoped to the owning org AND user, so neither
 * a cross-tenant nor a same-org-different-user caller can resolve (and thus
 * revoke) a session they do not own. Returns null if unknown.
 */
export async function lookupVoiceSessionJti(
  organizationId: string,
  userId: string,
  sessionId: string,
): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const value = await redis.get(sessionDirKey(organizationId, userId, sessionId));
  return typeof value === "string" && value ? value : null;
}

// ---------------------------------------------------------------------------
// Single-use claim: a voice-session token authorizes exactly ONE live WS
// connection. `claimVoiceSessionToken` atomically marks the jti as claimed;
// the FIRST caller wins, so two concurrent `hello` frames (even on different
// worker isolates) cannot both start a paid provider stream with one token.
// ---------------------------------------------------------------------------

const CLAIM_KEY_PREFIX = "voice-session:claimed:";

function claimKey(jti: string): string {
  return `${ENV_PREFIX}:${CLAIM_KEY_PREFIX}${jti}`;
}

/**
 * Atomically claim a token's jti for a single connection. Returns true only for
 * the FIRST caller (set-if-not-exists). Subsequent callers see false and must
 * reject the connection. When no durable store is configured, the per-worker
 * registry supersede is the only guard (single-worker dev), so we return true;
 * production requires Redis for cross-worker single-use enforcement.
 */
export async function claimVoiceSessionToken(jti: string, expSeconds: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(Math.ceil(expSeconds - nowSeconds), 1), MAX_REVOCATION_TTL_SECONDS);
  // `nx: true` => set only if absent; the first connection claims it.
  const result = await redis.set(claimKey(jti), "1", { ex: ttl, nx: true });
  return result !== null && result !== undefined;
}
