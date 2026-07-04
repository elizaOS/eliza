/**
 * Tests `verifyEmbedLaunch`, the shared connector-embed launch handshake:
 * accepts a correctly HMAC-signed Telegram Mini App `initData` (and an injected
 * Discord code exchange) for OWNER/ADMIN principals, and fails closed with 403
 * on insufficient role, forged signature, stale `auth_date`, missing bot token,
 * or a failed/empty Discord exchange — with role checks skipped once the payload
 * is rejected. Builds real signed Telegram payloads and injects a stub
 * `hasRoleAccess`/`discordExchange`; the clock is a fixed constant.
 */
import { createHmac } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type EmbedLaunchInput, verifyEmbedLaunch } from "./embed-handshake";

const hasRoleAccess = vi.fn(
  async (_r: unknown, _m: unknown, _role: string) => false,
);

const TEST_BOT_TOKEN = "123456:test-bot-token-abc";
const TELEGRAM_USER_ID = "987654321";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getSetting: (key: string) => settings[key] ?? null,
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;
}

/**
 * Build a real, correctly-signed Telegram `initData` query string so the
 * handshake's HMAC verification round-trips. The data-check-string is built
 * from the decoded values (matching the verifier), then each value is
 * URL-encoded into the query string.
 */
function buildTelegramInitData(
  fields: Record<string, string>,
  botToken: string,
): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  params.set("hash", hash);
  return params.toString();
}

const NOW = 1_700_000_000_000; // fixed clock for deterministic auth_date checks
const FRESH_AUTH_DATE = String(Math.floor(NOW / 1000) - 60); // 1 min old

function telegramFields(authDate = FRESH_AUTH_DATE): Record<string, string> {
  return {
    auth_date: authDate,
    query_id: "AAEturnstile",
    user: JSON.stringify({ id: Number(TELEGRAM_USER_ID), first_name: "Ada" }),
  };
}

describe("verifyEmbedLaunch", () => {
  beforeEach(() => {
    hasRoleAccess.mockReset();
    hasRoleAccess.mockResolvedValue(false);
  });

  function telegramInput(
    overrides: Partial<EmbedLaunchInput> = {},
    fields = telegramFields(),
  ): EmbedLaunchInput {
    return {
      platform: "telegram",
      signedLaunchPayload: buildTelegramInitData(fields, TEST_BOT_TOKEN),
      ...overrides,
    };
  }

  it("accepts a valid telegram launch for an OWNER", async () => {
    hasRoleAccess.mockImplementation(async (_r, _m, role) => role === "OWNER");
    const result = await verifyEmbedLaunch(
      telegramInput(),
      makeRuntime({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }),
      NOW,
      { hasRoleAccess },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe("OWNER");
      expect(result.adminMode).toBe(true);
      expect(result.entityId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("accepts a valid telegram launch for an ADMIN", async () => {
    hasRoleAccess.mockImplementation(async (_r, _m, role) => role === "ADMIN");
    const result = await verifyEmbedLaunch(
      telegramInput(),
      makeRuntime({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }),
      NOW,
      { hasRoleAccess },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe("ADMIN");
      expect(result.adminMode).toBe(true);
    }
  });

  it("rejects a telegram MEMBER (below ADMIN) with 403", async () => {
    hasRoleAccess.mockResolvedValue(false); // neither OWNER nor ADMIN
    const result = await verifyEmbedLaunch(
      telegramInput(),
      makeRuntime({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "insufficient_role",
    });
  });

  it("rejects a forged telegram hash before checking the role", async () => {
    hasRoleAccess.mockResolvedValue(true); // would pass if reached
    const valid = buildTelegramInitData(telegramFields(), TEST_BOT_TOKEN);
    const forged = valid.replace(/hash=[0-9a-f]+/, "hash=deadbeef");
    const result = await verifyEmbedLaunch(
      { platform: "telegram", signedLaunchPayload: forged },
      makeRuntime({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "telegram_bad_signature",
    });
    expect(hasRoleAccess).not.toHaveBeenCalled();
  });

  it("rejects an expired (stale-replay) telegram auth_date", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const staleDate = String(Math.floor(NOW / 1000) - 48 * 60 * 60); // 48h old
    const result = await verifyEmbedLaunch(
      telegramInput({}, telegramFields(staleDate)),
      makeRuntime({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN }),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "telegram_stale_auth_date",
    });
    expect(hasRoleAccess).not.toHaveBeenCalled();
  });

  it("rejects telegram when the bot token is unconfigured", async () => {
    const result = await verifyEmbedLaunch(
      telegramInput(),
      makeRuntime(),
      NOW,
      {
        hasRoleAccess,
      },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "telegram_bot_token_unconfigured",
    });
  });

  it("accepts a valid discord launch for an ADMIN via the injected exchange", async () => {
    hasRoleAccess.mockImplementation(async (_r, _m, role) => role === "ADMIN");
    const discordExchange = vi.fn(async () => ({ id: "discord-user-42" }));
    const result = await verifyEmbedLaunch(
      {
        platform: "discord",
        signedLaunchPayload: "oauth2-code-xyz",
        discordExchange,
      },
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(discordExchange).toHaveBeenCalledWith("oauth2-code-xyz");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe("ADMIN");
      expect(result.adminMode).toBe(true);
    }
  });

  it("rejects a discord launch when the exchange fails", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const discordExchange = vi.fn(async () => {
      throw new Error("discord 401");
    });
    const result = await verifyEmbedLaunch(
      {
        platform: "discord",
        signedLaunchPayload: "bad-code",
        discordExchange,
      },
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "discord_exchange_failed",
    });
    expect(hasRoleAccess).not.toHaveBeenCalled();
  });

  it("rejects a discord launch when the exchange returns no user", async () => {
    hasRoleAccess.mockResolvedValue(true);
    const result = await verifyEmbedLaunch(
      {
        platform: "discord",
        signedLaunchPayload: "code",
        discordExchange: async () => null,
      },
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "discord_unverified_user",
    });
  });
});
