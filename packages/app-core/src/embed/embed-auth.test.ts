import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateEmbedLaunch,
  verifyTelegramInitData,
} from "./embed-auth.ts";

const BOT_TOKEN = "123456:test-bot-token";
const NOW_MS = 1_700_000_000_000;

function signTelegramInitData(fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");
  params.set("hash", hash);
  return params.toString();
}

function runtime() {
  return { agentId: "00000000-0000-0000-0000-000000000001" };
}

describe("verifyTelegramInitData", () => {
  it("verifies Telegram Mini App initData HMAC and extracts the sender", () => {
    const initData = signTelegramInitData({
      auth_date: String(Math.floor(NOW_MS / 1000)),
      query_id: "query-1",
      user: JSON.stringify({ id: 42, username: "owner" }),
    });

    expect(
      verifyTelegramInitData({
        initData,
        botToken: BOT_TOKEN,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: true, userId: "42", displayName: "owner" });
  });

  it("fails closed for forged or expired Telegram initData", () => {
    const valid = signTelegramInitData({
      auth_date: String(Math.floor(NOW_MS / 1000)),
      user: JSON.stringify({ id: 42 }),
    });

    expect(
      verifyTelegramInitData({
        initData: valid.replace("42", "99"),
        botToken: BOT_TOKEN,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ ok: false, error: "bad_hash" });

    expect(
      verifyTelegramInitData({
        initData: signTelegramInitData({
          auth_date: String(Math.floor(NOW_MS / 1000) - 301),
          user: JSON.stringify({ id: 42 }),
        }),
        botToken: BOT_TOKEN,
        nowMs: NOW_MS,
        maxAgeSeconds: 300,
      }),
    ).toMatchObject({ ok: false, error: "expired" });
  });
});

describe("authenticateEmbedLaunch", () => {
  it("mints a scoped embed token only for OWNER or ADMIN senders", async () => {
    const roleAccess = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await authenticateEmbedLaunch({
      runtime: runtime() as never,
      platform: "telegram",
      signedLaunchPayload: signTelegramInitData({
        auth_date: String(Math.floor(NOW_MS / 1000)),
        user: JSON.stringify({ id: 42, username: "admin" }),
      }),
      telegramBotToken: BOT_TOKEN,
      sessionSecret: "embed-secret",
      nowMs: NOW_MS,
      roleAccess,
    });

    expect(result.ok).toBe(true);
    expect(result.sender).toMatchObject({
      platform: "telegram",
      platformUserId: "42",
      role: "ADMIN",
      displayName: "admin",
    });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(roleAccess).toHaveBeenCalledTimes(2);
  });

  it("returns 403 without minting a token for non-elevated senders", async () => {
    const result = await authenticateEmbedLaunch({
      runtime: runtime() as never,
      platform: "telegram",
      signedLaunchPayload: signTelegramInitData({
        auth_date: String(Math.floor(NOW_MS / 1000)),
        user: JSON.stringify({ id: 42 }),
      }),
      telegramBotToken: BOT_TOKEN,
      sessionSecret: "embed-secret",
      nowMs: NOW_MS,
      roleAccess: vi.fn(async () => false),
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "insufficient_role",
    });
  });

  it("fails closed for unsupported Discord verification until OAuth is wired", async () => {
    await expect(
      authenticateEmbedLaunch({
        runtime: runtime() as never,
        platform: "discord",
        signedLaunchPayload: "code",
        sessionSecret: "embed-secret",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 501,
      error: "discord_not_implemented",
    });
  });
});
