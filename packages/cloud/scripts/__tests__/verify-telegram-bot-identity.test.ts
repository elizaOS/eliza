/** Tests the deployment-time Telegram identity gate with no live provider calls. */

import { describe, expect, mock, test } from "bun:test";
import {
  TelegramIdentityVerificationError,
  verifyTelegramBotIdentity,
} from "../verify-telegram-bot-identity.mjs";

const expected = {
  botToken: "123456789:test-credential",
  expectedBotId: "123456789",
  expectedBotUsername: "ElizaTestBot",
  webhookSecret: "test-webhook-secret",
};

function providerIdentity(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    ok: true,
    result: {
      id: 123456789,
      is_bot: true,
      username: "elizatestbot",
      ...overrides,
    },
  });
}

describe("verifyTelegramBotIdentity", () => {
  test("accepts the exact id and a case-insensitive username", async () => {
    const provider = mock(async () => providerIdentity());

    await expect(
      verifyTelegramBotIdentity(expected, { fetchImpl: provider }),
    ).resolves.toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  test("rejects absent credentials and token-prefix drift before provider traffic", async () => {
    const provider = mock(async () => providerIdentity());

    for (const input of [
      { ...expected, webhookSecret: "" },
      { ...expected, botToken: "987654321:test-credential" },
    ]) {
      const error = await verifyTelegramBotIdentity(input, {
        fetchImpl: provider,
      }).catch((failure) => failure);
      expect(error).toBeInstanceOf(TelegramIdentityVerificationError);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  test("rejects wrong provider id and username", async () => {
    for (const result of [
      { id: 987654321 },
      { username: "AnotherManagedBot" },
    ]) {
      const error = await verifyTelegramBotIdentity(expected, {
        fetchImpl: mock(async () => providerIdentity(result)),
      }).catch((failure) => failure);
      expect(error).toMatchObject({
        name: "TelegramIdentityVerificationError",
        reason: "identity_mismatch",
      });
    }
  });

  test("classifies provider failure without exposing credentials or payload", async () => {
    const error = await verifyTelegramBotIdentity(expected, {
      fetchImpl: mock(async () =>
        Response.json(
          {
            ok: false,
            description: "private-provider-payload",
          },
          { status: 503 },
        ),
      ),
    }).catch((failure) => failure);

    expect(error).toMatchObject({
      message: "Telegram bot identity verification failed",
      reason: "provider_unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("test-credential");
    expect(JSON.stringify(error)).not.toContain("private-provider-payload");
  });
});
