/** Telegram embed handshakes require canonical Unix-second auth dates. */
import { createHmac } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type EmbedLaunchInput, verifyEmbedLaunch } from "./embed-handshake";

const hasRoleAccess = vi.fn(
  async (_r: unknown, _m: unknown, _role: string) => true,
);

const TEST_BOT_TOKEN = "123456:test-bot-token-abc";
const TELEGRAM_USER_ID = "987654321";
const NOW = 1_700_000_000_000;
const FRESH_AUTH_DATE = String(Math.floor(NOW / 1000) - 60);

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getSetting: (key: string) =>
      key === "TELEGRAM_BOT_TOKEN" ? TEST_BOT_TOKEN : null,
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;
}

function buildTelegramInitData(authDate: string): string {
  const fields: Record<string, string> = {
    auth_date: authDate,
    query_id: "AAEturnstile",
    user: JSON.stringify({ id: Number(TELEGRAM_USER_ID), first_name: "Ada" }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(TEST_BOT_TOKEN)
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

function telegramInput(authDate: string): EmbedLaunchInput {
  return {
    platform: "telegram",
    signedLaunchPayload: buildTelegramInitData(authDate),
  };
}

describe("embed handshake auth_date integers", () => {
  beforeEach(() => {
    hasRoleAccess.mockReset();
    hasRoleAccess.mockResolvedValue(true);
  });

  it("auth_date=1.7e9 is 403 before role checks", async () => {
    const result = await verifyEmbedLaunch(
      telegramInput("1.7e9"),
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "telegram_invalid_auth_date",
    });
    expect(hasRoleAccess).not.toHaveBeenCalled();
  });

  it("auth_date=1e2 is 403 before role checks", async () => {
    const result = await verifyEmbedLaunch(
      telegramInput("1e2"),
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "telegram_invalid_auth_date",
    });
    expect(hasRoleAccess).not.toHaveBeenCalled();
  });

  it("auth_date=007 is 403 before role checks", async () => {
    const result = await verifyEmbedLaunch(
      telegramInput("007"),
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "telegram_invalid_auth_date",
    });
    expect(hasRoleAccess).not.toHaveBeenCalled();
  });

  it("auth_date=0x10 is 403 before role checks", async () => {
    const result = await verifyEmbedLaunch(
      telegramInput("0x10"),
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "telegram_invalid_auth_date",
    });
    expect(hasRoleAccess).not.toHaveBeenCalled();
  });

  it("canonical auth_date still reaches role checks", async () => {
    const result = await verifyEmbedLaunch(
      telegramInput(FRESH_AUTH_DATE),
      makeRuntime(),
      NOW,
      { hasRoleAccess },
    );
    expect(result.ok).toBe(true);
    expect(hasRoleAccess).toHaveBeenCalled();
  });
});
