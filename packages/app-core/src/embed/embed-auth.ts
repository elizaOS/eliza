import { createHmac, timingSafeEqual } from "node:crypto";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { createUniqueUuid, hasRoleAccess } from "@elizaos/core";

export type EmbedPlatform = "telegram" | "discord";
export type EmbedRole = "OWNER" | "ADMIN";

export interface VerifiedEmbedSender {
  platform: EmbedPlatform;
  platformUserId: string;
  entityId: UUID;
  roomId: UUID;
  role: EmbedRole;
  displayName?: string;
}

export interface TelegramInitDataVerification {
  ok: boolean;
  userId?: string;
  displayName?: string;
  error?: string;
}

export interface AuthenticateEmbedLaunchParams {
  runtime: IAgentRuntime;
  platform: EmbedPlatform;
  signedLaunchPayload: string;
  telegramBotToken?: string;
  accountId?: string;
  nowMs?: number;
  maxAgeSeconds?: number;
  sessionSecret: string;
  roleAccess?: typeof hasRoleAccess;
}

export interface EmbedLaunchAuthResult {
  ok: boolean;
  status: 200 | 400 | 403 | 501;
  error?: string;
  sender?: VerifiedEmbedSender;
  token?: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseTelegramUser(value: string | null): {
  id?: string;
  displayName?: string;
} {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as {
      id?: number | string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    const id =
      typeof parsed.id === "number" || typeof parsed.id === "string"
        ? String(parsed.id)
        : undefined;
    const displayName =
      parsed.username ??
      [parsed.first_name, parsed.last_name].filter(Boolean).join(" ").trim() ??
      undefined;
    return { id, displayName: displayName || undefined };
  } catch {
    return {};
  }
}

export function verifyTelegramInitData(args: {
  initData: string;
  botToken: string;
  nowMs?: number;
  maxAgeSeconds?: number;
}): TelegramInitDataVerification {
  const params = new URLSearchParams(args.initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "missing_hash" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) {
    return { ok: false, error: "invalid_auth_date" };
  }

  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const maxAgeSeconds = args.maxAgeSeconds ?? 300;
  if (authDate > nowSeconds + 30 || nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, error: "expired" };
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData")
    .update(args.botToken)
    .digest();
  const expected = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");
  if (!safeEqualHex(hash, expected)) return { ok: false, error: "bad_hash" };

  const user = parseTelegramUser(params.get("user"));
  if (!user.id) return { ok: false, error: "missing_user" };
  return { ok: true, userId: user.id, displayName: user.displayName };
}

function mintEmbedSessionToken(args: {
  secret: string;
  sender: VerifiedEmbedSender;
  nowMs: number;
  ttlSeconds: number;
}): string {
  const payload = {
    typ: "elizaos.embed",
    platform: args.sender.platform,
    entityId: args.sender.entityId,
    role: args.sender.role,
    adminMode: true,
    iat: Math.floor(args.nowMs / 1000),
    exp: Math.floor(args.nowMs / 1000) + args.ttlSeconds,
  };
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = base64Url(
    createHmac("sha256", args.secret).update(encodedPayload).digest(),
  );
  return `${encodedPayload}.${signature}`;
}

export async function authenticateEmbedLaunch(
  args: AuthenticateEmbedLaunchParams,
): Promise<EmbedLaunchAuthResult> {
  if (args.platform === "discord") {
    return { ok: false, status: 501, error: "discord_not_implemented" };
  }
  if (!args.telegramBotToken) {
    return { ok: false, status: 400, error: "telegram_bot_token_required" };
  }

  const verified = verifyTelegramInitData({
    initData: args.signedLaunchPayload,
    botToken: args.telegramBotToken,
    nowMs: args.nowMs,
    maxAgeSeconds: args.maxAgeSeconds,
  });
  if (!verified.ok || !verified.userId) {
    return {
      ok: false,
      status: 403,
      error: verified.error ?? "invalid_payload",
    };
  }

  const accountId = args.accountId?.trim() || "default";
  const entityId = createUniqueUuid(
    args.runtime,
    `telegram:${accountId}:user:${verified.userId}`,
  ) as UUID;
  const roomId = createUniqueUuid(
    args.runtime,
    `telegram:${accountId}:embed:${verified.userId}`,
  ) as UUID;
  const memory: Memory = {
    id: createUniqueUuid(
      args.runtime,
      `telegram:${accountId}:embed-auth:${verified.userId}`,
    ) as UUID,
    entityId,
    agentId: args.runtime.agentId,
    roomId,
    content: { text: "/embed", source: "telegram" },
    createdAt: args.nowMs ?? Date.now(),
  };

  const checkRole = args.roleAccess ?? hasRoleAccess;
  const [isOwner, isAdmin] = await Promise.all([
    checkRole(args.runtime, memory, "OWNER"),
    checkRole(args.runtime, memory, "ADMIN"),
  ]);
  if (!isOwner && !isAdmin) {
    return { ok: false, status: 403, error: "insufficient_role" };
  }

  const sender: VerifiedEmbedSender = {
    platform: "telegram",
    platformUserId: verified.userId,
    entityId,
    roomId,
    role: isOwner ? "OWNER" : "ADMIN",
    displayName: verified.displayName,
  };
  const token = mintEmbedSessionToken({
    secret: args.sessionSecret,
    sender,
    nowMs: args.nowMs ?? Date.now(),
    ttlSeconds: 600,
  });
  return { ok: true, status: 200, sender, token };
}
