/**
 * Embedded-app launch handshake — the single server-side security seam for
 * role-gated Discord Activities and Telegram Mini Apps (#9947).
 *
 * The dashboard web bundle (`build:web`) is reused verbatim inside a 3rd-party
 * iframe (Telegram Mini App / Discord Activity). A first-party Steward
 * cookie/JWT cannot cross into that iframe, so the embed surface authenticates
 * with a connector-signed launch payload instead:
 *
 *   1. The connector verifies the platform's cryptographic launch proof
 *      (Telegram `initData` HMAC, Discord OAuth2 code exchange) — this is the
 *      hard identity boundary. Only a real platform user with a bot/app-signed
 *      payload gets past step 1.
 *   2. The verified platform user id is mapped to the runtime entity the
 *      connector's inbound pipeline already uses (account-scoped
 *      `createUniqueUuid`), and the agent's canonical role model is consulted
 *      via `hasRoleAccess` (the same check every connector surface runs).
 *   3. ONLY an OWNER/ADMIN identity is minted a short-lived, HMAC-signed embed
 *      session token carrying `entityId` + `role` + `adminMode`. Anything else
 *      — bad signature, no identity, stale payload, or insufficient role —
 *      fails closed with a 401/403 result.
 *
 * Hard rule: this module fails closed. There is no `catch { allow }` path; a
 * tampered payload, a stale `auth_date`, or a non-admin identity all return an
 * explicit failure the caller MUST refuse.
 *
 * Role-model note (consistent with every other connector gate): a deployment
 * with no configured owner and no world/role graph follows the lenient
 * no-world path inside `hasRoleAccess`. The cryptographic launch proof (step 1)
 * remains the enforced boundary in that case — an embed session is still only
 * mintable for a user who presents a valid bot/app-signed payload.
 */

import crypto from "node:crypto";
import {
  createUniqueUuid,
  hasRoleAccess,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";

export type EmbedPlatform = "telegram" | "discord";

/** Roles that may launch the embedded admin surface. OWNER outranks ADMIN. */
export type EmbedRole = "OWNER" | "ADMIN";

/** Account scoping sentinel — matches the connector command bridges. */
const DEFAULT_ACCOUNT_ID = "default";
/** Embed session token lifetime: short by design (re-launch is cheap). */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Reject Telegram launch payloads older than this (replay window). */
const DEFAULT_TELEGRAM_MAX_AUTH_AGE_SEC = 24 * 60 * 60;
/** Scope claim that marks a token as an embed session (vs any other token). */
const EMBED_SESSION_SCOPE = "embed" as const;
/** A signing secret shorter than this is treated as unconfigured. */
const MIN_SESSION_SECRET_LENGTH = 16;

/**
 * Account-scoped key matching the connector command bridges
 * (`scopedTelegramKey` in plugin-telegram), so the entity id derived here is
 * the same id the inbound message pipeline assigns to the sender.
 */
function scopedConnectorKey(key: string, accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? key : `${accountId}:${key}`;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── Telegram Mini App initData verification ──────────────────────────────────

export interface TelegramEmbedUser {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export type TelegramInitDataFailureReason =
  | "missing_init_data"
  | "missing_bot_token"
  | "missing_hash"
  | "missing_auth_date"
  | "signature_invalid"
  | "stale_auth_date"
  | "missing_user"
  | "user_unparseable";

export type VerifyTelegramInitDataResult =
  | { ok: true; userId: string; user: TelegramEmbedUser; authDate: number }
  | { ok: false; reason: TelegramInitDataFailureReason };

export interface VerifyTelegramInitDataOptions {
  /** Max age of `auth_date` (seconds). Default 24h. */
  maxAuthAgeSec?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

/**
 * Verify a Telegram Mini App `initData` payload.
 *
 * Algorithm (Telegram Bot API "Validating data received via the Mini App"):
 *   secret_key   = HMAC_SHA256(key="WebAppData", message=bot_token)
 *   check_string = sorted "k=v" of every field except `hash`, joined by "\n"
 *   valid        = HMAC_SHA256(key=secret_key, message=check_string) === hash
 *
 * Returns the verified Telegram user id on success; fails closed on a missing
 * field, a signature mismatch, or a stale `auth_date`.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: VerifyTelegramInitDataOptions = {},
): VerifyTelegramInitDataResult {
  if (!initData || typeof initData !== "string") {
    return { ok: false, reason: "missing_init_data" };
  }
  if (!botToken || typeof botToken !== "string") {
    return { ok: false, reason: "missing_bot_token" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) return { ok: false, reason: "missing_auth_date" };
  const authDate = Number.parseInt(authDateRaw, 10);
  if (!Number.isFinite(authDate)) {
    return { ok: false, reason: "missing_auth_date" };
  }

  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const computed = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!timingSafeEqualString(computed, hash.toLowerCase())) {
    return { ok: false, reason: "signature_invalid" };
  }

  const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const maxAge = options.maxAuthAgeSec ?? DEFAULT_TELEGRAM_MAX_AUTH_AGE_SEC;
  if (nowSec - authDate > maxAge) {
    return { ok: false, reason: "stale_auth_date" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing_user" };
  try {
    const parsed = JSON.parse(userRaw) as {
      id?: unknown;
      username?: unknown;
      first_name?: unknown;
      last_name?: unknown;
    };
    if (parsed.id === undefined || parsed.id === null) {
      return { ok: false, reason: "user_unparseable" };
    }
    const user: TelegramEmbedUser = {
      id: String(parsed.id),
      username:
        typeof parsed.username === "string" ? parsed.username : undefined,
      firstName:
        typeof parsed.first_name === "string" ? parsed.first_name : undefined,
      lastName:
        typeof parsed.last_name === "string" ? parsed.last_name : undefined,
    };
    return { ok: true, userId: user.id, user, authDate };
  } catch {
    return { ok: false, reason: "user_unparseable" };
  }
}

// ── Embed session token (HMAC-signed, JWT-compatible HS256) ───────────────────

export interface EmbedSessionClaims {
  scope: typeof EMBED_SESSION_SCOPE;
  platform: EmbedPlatform;
  /** Runtime entity id the embed session acts as. */
  entityId: string;
  /** Platform user id (subject). */
  sub: string;
  role: EmbedRole;
  /** True when the session grants the admin embed surface. */
  adminMode: boolean;
  accountId: string;
  /** Issued-at (seconds). */
  iat: number;
  /** Expiry (seconds). */
  exp: number;
}

/**
 * Mint an HMAC-signed (HS256) embed session token. The shape is JWT-compatible
 * (`header.payload.signature`, base64url) so existing JWT tooling can read it,
 * but verification stays in-process via {@link verifyEmbedSessionToken}.
 */
export function mintEmbedSessionToken(
  claims: EmbedSessionClaims,
  secret: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Verify and decode an embed session token. Returns the claims on success or
 * `null` for a bad signature, a malformed token, the wrong scope, or expiry.
 */
export function verifyEmbedSessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): EmbedSessionClaims | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  if (!timingSafeEqualString(signature, expected)) return null;

  let claims: EmbedSessionClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as EmbedSessionClaims;
  } catch {
    return null;
  }
  if (claims.scope !== EMBED_SESSION_SCOPE) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
  if (typeof claims.entityId !== "string" || claims.entityId.length === 0) {
    return null;
  }
  return claims;
}

// ── Role gate + token mint (the single seam every connector calls) ────────────

export type VerifyEmbedLaunchResult =
  | { ok: true; token: string; claims: EmbedSessionClaims }
  | { ok: false; status: 401 | 403; reason: string };

export interface AuthorizeEmbedSessionParams {
  runtime: IAgentRuntime;
  platform: EmbedPlatform;
  /** Verified platform user id (subject). */
  subject: string;
  /** Connector-scoped runtime entity id (resolved by the caller). */
  entityId: UUID;
  /** Connector-scoped room id for world/role resolution. */
  roomId: UUID;
  accountId: string;
  /** Server secret used to HMAC-sign the embed session token. */
  sessionSecret: string;
  /** Minimum role required to launch. Default ADMIN (OWNER also satisfies). */
  requiredRole?: EmbedRole;
  /** Token lifetime in ms. Default 1h. */
  tokenTtlMs?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

/**
 * Gate an already-identified embed launch against the agent role model and mint
 * a session token on success. This is the single authorization seam — Telegram,
 * Discord, and any future connector funnel through here after establishing the
 * platform identity, so the role decision is defined exactly once.
 */
export async function authorizeEmbedSession(
  params: AuthorizeEmbedSessionParams,
): Promise<VerifyEmbedLaunchResult> {
  const { runtime, platform, subject, entityId, roomId, accountId } = params;

  if (
    !params.sessionSecret ||
    params.sessionSecret.length < MIN_SESSION_SECRET_LENGTH
  ) {
    return { ok: false, status: 401, reason: "missing_session_secret" };
  }

  const requiredRole = params.requiredRole ?? "ADMIN";
  const nowMs = params.now?.() ?? Date.now();

  const memory: Memory = {
    id: createUniqueUuid(
      runtime,
      `embed-${platform}-${subject}-${nowMs}`,
    ) as UUID,
    entityId,
    agentId: runtime.agentId as UUID,
    roomId,
    content: { text: "/embed", source: platform },
    createdAt: nowMs,
  };

  const [isOwner, isAdmin] = await Promise.all([
    hasRoleAccess(runtime, memory, "OWNER"),
    hasRoleAccess(runtime, memory, "ADMIN"),
  ]);

  const satisfied = requiredRole === "OWNER" ? isOwner : isAdmin;
  if (!satisfied) {
    return { ok: false, status: 403, reason: "insufficient_role" };
  }
  const role: EmbedRole = isOwner ? "OWNER" : "ADMIN";

  const ttlMs = params.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const claims: EmbedSessionClaims = {
    scope: EMBED_SESSION_SCOPE,
    platform,
    entityId,
    sub: subject,
    role,
    adminMode: true,
    accountId,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + ttlMs) / 1000),
  };
  return {
    ok: true,
    token: mintEmbedSessionToken(claims, params.sessionSecret),
    claims,
  };
}

// ── High-level launch verification (per platform) ─────────────────────────────

interface EmbedLaunchCommon {
  runtime: IAgentRuntime;
  /** Server secret used to HMAC-sign the embed session token. */
  sessionSecret: string;
  /** Connector account scope. Default `"default"`. */
  accountId?: string;
  /** Minimum role required. Default ADMIN. */
  requiredRole?: EmbedRole;
  /** Token lifetime in ms. Default 1h. */
  tokenTtlMs?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

export interface TelegramEmbedLaunchParams extends EmbedLaunchCommon {
  platform: "telegram";
  /** Raw Telegram Mini App `initData` query string. */
  initData: string;
  botToken: string;
  /** Max age of `auth_date` (seconds). Default 24h. */
  maxAuthAgeSec?: number;
}

/**
 * Exchange a Discord Activity OAuth2 authorization code for the launching
 * user's id. Injected so the seam is unit-testable; the live implementation
 * POSTs to `https://discord.com/api/oauth2/token` then `GET /users/@me`.
 */
export type DiscordOAuthExchange = (
  code: string,
) => Promise<{ userId: string } | null>;

export interface DiscordEmbedLaunchParams extends EmbedLaunchCommon {
  platform: "discord";
  /** OAuth2 authorization code from the Embedded App SDK. */
  code: string;
  /** Token-exchange + user-fetch implementation (injectable for tests). */
  exchangeCode: DiscordOAuthExchange;
  /**
   * Owner-aware entity resolver. Discord maps application-owner snowflakes onto
   * the canonical owner entity (`resolveDiscordRuntimeEntityId`); the connector
   * passes that resolver so the role check matches the inbound pipeline. When
   * omitted, plain account-scoped `createUniqueUuid` is used (correct for any
   * non-owner user; an application owner should supply the resolver).
   */
  resolveEntityId?: (userId: string) => { entityId: UUID; roomId: UUID };
}

export type VerifyEmbedLaunchParams =
  | TelegramEmbedLaunchParams
  | DiscordEmbedLaunchParams;

/**
 * Verify a connector embed launch end-to-end: validate the platform launch
 * proof, resolve the runtime entity, gate against the role model, and mint a
 * session token. Fails closed with a 401 (bad/absent identity) or 403
 * (insufficient role).
 */
export async function verifyEmbedLaunch(
  params: VerifyEmbedLaunchParams,
): Promise<VerifyEmbedLaunchResult> {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;

  if (params.platform === "telegram") {
    const verified = verifyTelegramInitData(params.initData, params.botToken, {
      maxAuthAgeSec: params.maxAuthAgeSec,
      now: params.now,
    });
    if (!verified.ok) {
      return { ok: false, status: 401, reason: `telegram_${verified.reason}` };
    }
    const entityId = createUniqueUuid(
      params.runtime,
      scopedConnectorKey(verified.userId, accountId),
    ) as UUID;
    const roomId = createUniqueUuid(
      params.runtime,
      scopedConnectorKey(`embed:${verified.userId}`, accountId),
    ) as UUID;
    return authorizeEmbedSession({
      runtime: params.runtime,
      platform: "telegram",
      subject: verified.userId,
      entityId,
      roomId,
      accountId,
      sessionSecret: params.sessionSecret,
      requiredRole: params.requiredRole,
      tokenTtlMs: params.tokenTtlMs,
      now: params.now,
    });
  }

  let exchanged: { userId: string } | null;
  try {
    exchanged = await params.exchangeCode(params.code);
  } catch {
    return { ok: false, status: 401, reason: "discord_exchange_failed" };
  }
  if (!exchanged?.userId) {
    return { ok: false, status: 401, reason: "discord_exchange_failed" };
  }

  const resolved = params.resolveEntityId?.(exchanged.userId);
  const entityId =
    resolved?.entityId ??
    (createUniqueUuid(
      params.runtime,
      scopedConnectorKey(exchanged.userId, accountId),
    ) as UUID);
  const roomId =
    resolved?.roomId ??
    (createUniqueUuid(
      params.runtime,
      scopedConnectorKey(`embed:${exchanged.userId}`, accountId),
    ) as UUID);

  return authorizeEmbedSession({
    runtime: params.runtime,
    platform: "discord",
    subject: exchanged.userId,
    entityId,
    roomId,
    accountId,
    sessionSecret: params.sessionSecret,
    requiredRole: params.requiredRole,
    tokenTtlMs: params.tokenTtlMs,
    now: params.now,
  });
}
