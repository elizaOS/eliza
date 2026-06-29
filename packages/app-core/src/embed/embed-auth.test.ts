import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The seam maps platform identities to runtime entities and consults the agent
// role model. Mock both so each test controls identity + trust without a full
// world/role graph. `createUniqueUuid` is deterministic on its key.
const { hasRoleAccess, createUniqueUuid } = vi.hoisted(() => ({
  hasRoleAccess: vi.fn(
    async (_runtime: unknown, _message: unknown, _role: string) => true,
  ),
  createUniqueUuid: vi.fn((_runtime: unknown, key: string) => `uuid:${key}`),
}));
vi.mock("@elizaos/core", () => ({ hasRoleAccess, createUniqueUuid }));

import type { IAgentRuntime } from "@elizaos/core";
import {
  authorizeEmbedSession,
  type EmbedSessionClaims,
  mintEmbedSessionToken,
  verifyEmbedLaunch,
  verifyEmbedSessionToken,
  verifyTelegramInitData,
} from "./embed-auth";

const BOT_TOKEN = "123456:test-bot-token-abcDEF";
const SESSION_SECRET = "embed-session-secret-0123456789";
const NOW_MS = 1_700_000_000_000;
const nowFn = () => NOW_MS;

const runtime = { agentId: "agent-1" } as unknown as IAgentRuntime;

/** Build a Telegram `initData` query string signed with `botToken`. */
function buildInitData(
  botToken: string,
  fields: Record<string, string>,
): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function validFields(
  authDateSec = Math.floor(NOW_MS / 1000),
): Record<string, string> {
  return {
    auth_date: String(authDateSec),
    query_id: "AAH-test",
    user: JSON.stringify({ id: 4242, username: "tester", first_name: "Test" }),
  };
}

beforeEach(() => {
  hasRoleAccess.mockReset();
  hasRoleAccess.mockResolvedValue(true);
  createUniqueUuid.mockClear();
});

describe("verifyTelegramInitData", () => {
  it("verifies a correctly signed payload and returns the user id", () => {
    const initData = buildInitData(BOT_TOKEN, validFields());
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now: nowFn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("4242");
      expect(result.user.username).toBe("tester");
    }
  });

  it("fails closed on a tampered hash", () => {
    const initData = buildInitData(BOT_TOKEN, validFields());
    const tampered = initData.replace(
      /hash=[0-9a-f]+/,
      `hash=${"0".repeat(64)}`,
    );
    const result = verifyTelegramInitData(tampered, BOT_TOKEN, { now: nowFn });
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("fails closed when signed with a different bot token", () => {
    const initData = buildInitData("999:other-token", validFields());
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now: nowFn });
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("fails closed on a stale auth_date", () => {
    const stale = Math.floor(NOW_MS / 1000) - 48 * 60 * 60;
    const initData = buildInitData(BOT_TOKEN, validFields(stale));
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now: nowFn });
    expect(result).toEqual({ ok: false, reason: "stale_auth_date" });
  });

  it("fails closed when the hash field is absent", () => {
    const result = verifyTelegramInitData(
      "auth_date=1&user=%7B%7D",
      BOT_TOKEN,
      {
        now: nowFn,
      },
    );
    expect(result).toEqual({ ok: false, reason: "missing_hash" });
  });

  it("fails closed when the user field is absent", () => {
    const initData = buildInitData(BOT_TOKEN, {
      auth_date: String(Math.floor(NOW_MS / 1000)),
      query_id: "AAH-test",
    });
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now: nowFn });
    expect(result).toEqual({ ok: false, reason: "missing_user" });
  });
});

describe("embed session token", () => {
  const claims: EmbedSessionClaims = {
    scope: "embed",
    platform: "telegram",
    entityId: "uuid:4242",
    sub: "4242",
    role: "ADMIN",
    adminMode: true,
    accountId: "default",
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
  };

  it("round-trips mint -> verify", () => {
    const token = mintEmbedSessionToken(claims, SESSION_SECRET);
    expect(verifyEmbedSessionToken(token, SESSION_SECRET, NOW_MS)).toEqual(
      claims,
    );
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintEmbedSessionToken(claims, SESSION_SECRET);
    expect(
      verifyEmbedSessionToken(token, "wrong-secret-0123456789", NOW_MS),
    ).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = mintEmbedSessionToken(claims, SESSION_SECRET);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...claims, role: "OWNER" }),
    ).toString("base64url");
    expect(
      verifyEmbedSessionToken(`${h}.${forged}.${s}`, SESSION_SECRET, NOW_MS),
    ).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = mintEmbedSessionToken(claims, SESSION_SECRET);
    const past = (claims.exp + 1) * 1000;
    expect(verifyEmbedSessionToken(token, SESSION_SECRET, past)).toBeNull();
  });
});

describe("authorizeEmbedSession", () => {
  const base = {
    runtime,
    platform: "telegram" as const,
    subject: "4242",
    entityId: "uuid:4242" as never,
    roomId: "uuid:room" as never,
    accountId: "default",
    sessionSecret: SESSION_SECRET,
    now: nowFn,
  };

  it("mints an admin session when the role check passes", async () => {
    hasRoleAccess.mockImplementation(
      async (_rt, _msg, role: string) => role === "ADMIN",
    );
    const result = await authorizeEmbedSession(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.role).toBe("ADMIN");
      expect(result.claims.adminMode).toBe(true);
      expect(
        verifyEmbedSessionToken(result.token, SESSION_SECRET, NOW_MS),
      ).toEqual(result.claims);
    }
  });

  it("labels an owner session OWNER", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const result = await authorizeEmbedSession(base);
    expect(result.ok && result.claims.role).toBe("OWNER");
  });

  it("fails closed (403) on insufficient role", async () => {
    hasRoleAccess.mockResolvedValue(false);
    const result = await authorizeEmbedSession(base);
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "insufficient_role",
    });
  });

  it("fails closed (401) without a session secret", async () => {
    const result = await authorizeEmbedSession({ ...base, sessionSecret: "" });
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "missing_session_secret",
    });
  });
});

describe("verifyEmbedLaunch (telegram)", () => {
  it("verifies + mints for an admin launch", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const result = await verifyEmbedLaunch({
      platform: "telegram",
      runtime,
      initData: buildInitData(BOT_TOKEN, validFields()),
      botToken: BOT_TOKEN,
      sessionSecret: SESSION_SECRET,
      now: nowFn,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.platform).toBe("telegram");
  });

  it("fails closed (401) on a tampered payload", async () => {
    const initData = buildInitData(BOT_TOKEN, validFields()).replace(
      /hash=[0-9a-f]+/,
      `hash=${"0".repeat(64)}`,
    );
    const result = await verifyEmbedLaunch({
      platform: "telegram",
      runtime,
      initData,
      botToken: BOT_TOKEN,
      sessionSecret: SESSION_SECRET,
      now: nowFn,
    });
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "telegram_signature_invalid",
    });
  });

  it("fails closed (403) for a verified-but-non-admin user", async () => {
    hasRoleAccess.mockResolvedValue(false);
    const result = await verifyEmbedLaunch({
      platform: "telegram",
      runtime,
      initData: buildInitData(BOT_TOKEN, validFields()),
      botToken: BOT_TOKEN,
      sessionSecret: SESSION_SECRET,
      now: nowFn,
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "insufficient_role",
    });
  });
});

describe("verifyEmbedLaunch (discord)", () => {
  it("verifies + mints when the code exchange yields an admin user", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const result = await verifyEmbedLaunch({
      platform: "discord",
      runtime,
      code: "auth-code",
      exchangeCode: async (code) => {
        expect(code).toBe("auth-code");
        return { userId: "9001" };
      },
      sessionSecret: SESSION_SECRET,
      now: nowFn,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.platform).toBe("discord");
      expect(result.claims.sub).toBe("9001");
    }
  });

  it("fails closed (401) when the code exchange returns null", async () => {
    const result = await verifyEmbedLaunch({
      platform: "discord",
      runtime,
      code: "bad",
      exchangeCode: async () => null,
      sessionSecret: SESSION_SECRET,
      now: nowFn,
    });
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "discord_exchange_failed",
    });
  });

  it("fails closed (401) when the code exchange throws", async () => {
    const result = await verifyEmbedLaunch({
      platform: "discord",
      runtime,
      code: "boom",
      exchangeCode: async () => {
        throw new Error("network");
      },
      sessionSecret: SESSION_SECRET,
      now: nowFn,
    });
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "discord_exchange_failed",
    });
  });

  it("honors an owner-aware entity resolver", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const resolveEntityId = vi.fn((userId: string) => ({
      entityId: `owner-entity:${userId}` as never,
      roomId: "owner-room" as never,
    }));
    const result = await verifyEmbedLaunch({
      platform: "discord",
      runtime,
      code: "c",
      exchangeCode: async () => ({ userId: "owner-1" }),
      resolveEntityId,
      sessionSecret: SESSION_SECRET,
      now: nowFn,
    });
    expect(resolveEntityId).toHaveBeenCalledWith("owner-1");
    expect(result.ok && result.claims.entityId).toBe("owner-entity:owner-1");
  });
});
