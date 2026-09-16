/** Tests the deployment-time Telegram identity gate with no live provider calls. */

import { describe, expect, mock, test } from "bun:test";
import { verifyTelegramBotIdentity } from "../verify-telegram-bot-identity.mjs";

const expected = {
  botToken: "123456789:test-credential",
  expectedBotId: "123456789",
  expectedBotUsername: "ElizaTestBot",
  webhookSecret: "test-webhook-secret",
};

async function captureFailure<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected Telegram identity verification to reject");
  } catch (error) {
    // error-policy:J1 the test assertion boundary observes the exact
    // deployment-preflight rejection instead of suppressing it.
    return error;
  }
}

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
      const error = await captureFailure(
        verifyTelegramBotIdentity(input, { fetchImpl: provider }),
      );
      expect(error).toMatchObject({
        code: "TELEGRAM_IDENTITY_VERIFICATION_FAILED",
        name: "TelegramIdentityVerificationError",
      });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  test("rejects wrong provider id and username", async () => {
    for (const result of [
      { id: 987654321 },
      { username: "AnotherManagedBot" },
    ]) {
      const error = await captureFailure(
        verifyTelegramBotIdentity(expected, {
          fetchImpl: mock(async () => providerIdentity(result)),
        }),
      );
      expect(error).toMatchObject({
        code: "TELEGRAM_IDENTITY_VERIFICATION_FAILED",
        context: { reason: "identity_mismatch" },
        name: "TelegramIdentityVerificationError",
        reason: "identity_mismatch",
      });
    }
  });

  test("classifies provider failure without exposing credentials or payload", async () => {
    const error = await captureFailure(
      verifyTelegramBotIdentity(expected, {
        fetchImpl: mock(async () =>
          Response.json(
            {
              ok: false,
              description: "private-provider-payload",
            },
            { status: 503 },
          ),
        ),
      }),
    );

    expect(error).toMatchObject({
      message: "Telegram bot identity verification failed",
      reason: "provider_unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("test-credential");
    expect(JSON.stringify(error)).not.toContain("private-provider-payload");
  });
});
