import { createHmac, timingSafeEqual } from "node:crypto";
import {
  hasRoleAccess as coreHasRoleAccess,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import type { EmbedRole } from "./embed-session-token";

/**
 * Shared embedded-app launch handshake — the single security seam every
 * connector embed (Telegram Mini App, Discord Activity) flows through before
 * the caller mints a scoped session token (#9947).
 *
 * The seam verifies a platform-signed launch payload, maps the verified
 * platform user to the same account-scoped `entityId` the inbound connector
 * pipeline assigns, and resolves the sender's trust level with the one core
 * `hasRoleAccess` primitive (never a connector-local copy). It fails closed on
 * every failure mode: bad signature, stale replay, missing identity, or a role
 * below ADMIN.
 */

/** Telegram WebApp `auth_date` older than this is rejected as a replay. */
const TELEGRAM_INITDATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Account id used for entity scoping when a connector has a single account. */
const DEFAULT_ACCOUNT_ID = "default";

export type EmbedPlatform = "telegram" | "discord";

/** A Discord user resolved from a server-side OAuth2 code exchange. */
export interface DiscordVerifiedUser {
  id: string;
}

/**
 * Injected Discord token-exchange. Production passes a real implementation that
 * exchanges the Activity OAuth2 `code` for an access token and fetches the
 * user; tests pass a deterministic stub. Returns `null` on any failure.
 */
export type DiscordExchange = (
  code: string,
) => Promise<DiscordVerifiedUser | null>;

export interface EmbedLaunchDeps {
  hasRoleAccess?: typeof coreHasRoleAccess;
}

export interface EmbedLaunchInput {
  platform: EmbedPlatform;
  /**
   * Telegram: the WebApp `initData` URL-encoded query string.
   * Discord: the Activity OAuth2 authorization `code`.
   */
  signedLaunchPayload: string;
  /** Connector account id for entity scoping (multi-account connectors). */
  accountId?: string;
  /** Discord-only: server-side token exchange used to verify the user. */
  discordExchange?: DiscordExchange;
}

/**
 * Only elevated roles pass the embed gate; everything else fails closed. #12087
 * Item 30: re-exported from the single {@link EMBED_ELEVATED_ROLES} definition in
 * embed-session-token.ts so the handshake result and the minted token claims
 * share one elevated-role set.
 */
export type { EmbedRole };

export type EmbedLaunchResult =
  | { ok: true; entityId: UUID; role: EmbedRole; adminMode: boolean }
  | { ok: false; status: 403; reason: string };

function reject(platform: EmbedPlatform, reason: string): EmbedLaunchResult {
  logger.warn(
    { platform, reason },
    "[EmbedHandshake] embed launch rejected (fail closed)",
  );
  return { ok: false, status: 403, reason };
}

/** Account-scoped entity key matching the connector inbound pipeline. */
function scopedKey(accountId: string, key: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? key : `${accountId}:${key}`;
}

type TelegramVerification =
  | { ok: true; userId: string }
  | { ok: false; reason: string };

function verifyTelegramInitData(
  initData: string,
  botToken: string,
  now: number,
): TelegramVerification {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) {
    return { ok: false, reason: "telegram_missing_hash" };
  }
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => [key, value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expected = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const received = Buffer.from(receivedHash, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (
    received.length !== expectedBuf.length ||
    !timingSafeEqual(received, expectedBuf)
  ) {
    return { ok: false, reason: "telegram_bad_signature" };
  }

  const authDateSeconds = Number(params.get("auth_date"));
  if (!Number.isFinite(authDateSeconds) || authDateSeconds <= 0) {
    return { ok: false, reason: "telegram_missing_auth_date" };
  }
  if (now - authDateSeconds * 1000 > TELEGRAM_INITDATA_MAX_AGE_MS) {
    return { ok: false, reason: "telegram_stale_auth_date" };
  }

  const userId = parseTelegramUserId(params.get("user"));
  if (!userId) {
    return { ok: false, reason: "telegram_missing_user" };
  }
  return { ok: true, userId };
}

function parseTelegramUserId(userField: string | null): string | null {
  if (!userField) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(userField);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "id" in parsed &&
    (typeof (parsed as { id: unknown }).id === "number" ||
      typeof (parsed as { id: unknown }).id === "string")
  ) {
    const id = (parsed as { id: number | string }).id;
    const idStr = String(id);
    return idStr.length > 0 ? idStr : null;
  }
  return null;
}

/**
 * Resolve the sender's role from the core role model and return the verified
 * principal only when it reaches ADMIN or OWNER. Shared by both platforms so
 * there is exactly one authorization decision in the seam.
 */
async function authorizeEntity(
  runtime: IAgentRuntime,
  platform: EmbedPlatform,
  entityKey: string,
  userId: string,
  now: number,
  deps: EmbedLaunchDeps,
): Promise<EmbedLaunchResult> {
  const hasRoleAccess = deps.hasRoleAccess ?? coreHasRoleAccess;
  const entityId = createUniqueUuid(runtime, entityKey) as UUID;
  const roomId = createUniqueUuid(
    runtime,
    `embed-room-${platform}-${userId}`,
  ) as UUID;
  const memory: Memory = {
    id: createUniqueUuid(runtime, `embed-${platform}-${userId}`) as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: { text: "", source: `${platform}-embed` },
    createdAt: now,
  };

  if (await hasRoleAccess(runtime, memory, "OWNER")) {
    return { ok: true, entityId, role: "OWNER", adminMode: true };
  }
  if (await hasRoleAccess(runtime, memory, "ADMIN")) {
    return { ok: true, entityId, role: "ADMIN", adminMode: true };
  }
  return reject(platform, "insufficient_role");
}

async function verifyTelegramLaunch(
  input: EmbedLaunchInput,
  runtime: IAgentRuntime,
  now: number,
  deps: EmbedLaunchDeps,
): Promise<EmbedLaunchResult> {
  const botTokenSetting = runtime.getSetting("TELEGRAM_BOT_TOKEN");
  const botToken =
    typeof botTokenSetting === "string" ? botTokenSetting.trim() : "";
  if (!botToken) {
    return reject("telegram", "telegram_bot_token_unconfigured");
  }

  const verification = verifyTelegramInitData(
    input.signedLaunchPayload,
    botToken,
    now,
  );
  if (!verification.ok) {
    return reject("telegram", verification.reason);
  }

  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  return authorizeEntity(
    runtime,
    "telegram",
    scopedKey(accountId, verification.userId),
    verification.userId,
    now,
    deps,
  );
}

async function verifyDiscordLaunch(
  input: EmbedLaunchInput,
  runtime: IAgentRuntime,
  now: number,
  deps: EmbedLaunchDeps,
): Promise<EmbedLaunchResult> {
  const { discordExchange } = input;
  if (!discordExchange) {
    return reject("discord", "discord_exchange_unconfigured");
  }

  let user: DiscordVerifiedUser | null;
  try {
    user = await discordExchange(input.signedLaunchPayload);
  } catch {
    return reject("discord", "discord_exchange_failed");
  }
  if (!user || typeof user.id !== "string" || user.id.length === 0) {
    return reject("discord", "discord_unverified_user");
  }

  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  return authorizeEntity(
    runtime,
    "discord",
    scopedKey(accountId, user.id),
    user.id,
    now,
    deps,
  );
}

/**
 * Verify an embedded-app launch and return the verified principal (OWNER/ADMIN)
 * or a fail-closed 403. The caller mints the scoped session token from
 * `entityId` + `role` + `adminMode`; this seam performs no token minting.
 */
export async function verifyEmbedLaunch(
  input: EmbedLaunchInput,
  runtime: IAgentRuntime,
  now: number = Date.now(),
  deps: EmbedLaunchDeps = {},
): Promise<EmbedLaunchResult> {
  if (input.platform === "telegram") {
    return verifyTelegramLaunch(input, runtime, now, deps);
  }
  return verifyDiscordLaunch(input, runtime, now, deps);
}
