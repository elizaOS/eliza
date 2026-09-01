/** Exercises value-safe Telegram getMe attestation without real provider traffic. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import {
  __resetTelegramIdentityAttestationCacheForTests,
  attestTelegramBotIdentity,
  TelegramIdentityAttestationError,
} from "./telegram-connector";

const originalFetch = globalThis.fetch;
const expected = {
  botToken: "123456789:test-credential",
  botId: "123456789",
  botUsername: "ElizaTestBot",
};

async function captureFailure<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected Telegram identity attestation to reject");
  } catch (error) {
    // error-policy:J1 the test assertion boundary observes the exact typed
    // rejection instead of suppressing it.
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetTelegramIdentityAttestationCacheForTests();
  mock.restore();
});

describe("attestTelegramBotIdentity", () => {
  test("attests the exact id and case-insensitive username once per cache window", async () => {
    const provider = mock(async () => providerIdentity());
    globalThis.fetch = provider as unknown as typeof fetch;

    const [first, concurrent] = await Promise.all([
      attestTelegramBotIdentity(expected),
      attestTelegramBotIdentity(expected),
    ]);
    const cached = await attestTelegramBotIdentity(expected);

    expect(first).toEqual({
      botId: "123456789",
      botUsername: "ElizaTestBot",
    });
    expect(concurrent).toEqual(first);
    expect(cached).toEqual(first);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  test("rejects a token-prefix mismatch before provider traffic", async () => {
    const provider = mock(async () => providerIdentity());
    globalThis.fetch = provider as unknown as typeof fetch;

    const error = await captureFailure(
      attestTelegramBotIdentity({
        ...expected,
        botToken: "987654321:test-credential",
      }),
    );

    expect(error).toBeInstanceOf(TelegramIdentityAttestationError);
    expect(error).toBeInstanceOf(ElizaError);
    expect(error).toMatchObject({
      code: "TELEGRAM_IDENTITY_ATTESTATION_FAILED",
      context: { reason: "identity_mismatch", retryable: false },
      reason: "identity_mismatch",
      retryable: false,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  test("rejects provider id and username mismatches", async () => {
    for (const result of [
      { id: 987654321 },
      { username: "AnotherManagedBot" },
    ]) {
      __resetTelegramIdentityAttestationCacheForTests();
      globalThis.fetch = mock(async () =>
        providerIdentity(result),
      ) as unknown as typeof fetch;
      const error = await captureFailure(attestTelegramBotIdentity(expected));
      expect(error).toMatchObject({
        name: "TelegramIdentityAttestationError",
        reason: "identity_mismatch",
        retryable: false,
      });
    }
  });

  test("treats malformed or unavailable provider identity as retryable and redacted", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: false,
        error_code: 503,
        description: "private-provider-payload",
      }),
    ) as unknown as typeof fetch;

    const error = await captureFailure(attestTelegramBotIdentity(expected));

    expect(error).toMatchObject({
      name: "TelegramIdentityAttestationError",
      message: "Telegram bot identity attestation failed",
      reason: "provider_unavailable",
      retryable: true,
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("test-credential");
    expect(JSON.stringify(error)).not.toContain("private-provider-payload");
  });

  test("requires a complete well-formed expected identity", async () => {
    for (const config of [
      {},
      { botToken: expected.botToken, botId: expected.botId },
      { ...expected, botId: "0" },
      { ...expected, botUsername: "not-a-managed-name" },
    ]) {
      const error = await captureFailure(attestTelegramBotIdentity(config));
      expect(error).toBeInstanceOf(TelegramIdentityAttestationError);
      expect(error).toMatchObject({ retryable: false });
    }
  });

  test("re-attests after token rotation", async () => {
    const provider = mock(async (input: RequestInfo | URL) => {
      const tokenId = String(input).includes("987654321:")
        ? 987654321
        : 123456789;
      return providerIdentity({
        id: tokenId,
        username: tokenId === 987654321 ? "RotatedTestBot" : "ElizaTestBot",
      });
    });
    globalThis.fetch = provider as unknown as typeof fetch;

    await attestTelegramBotIdentity(expected);
    await attestTelegramBotIdentity({
      botToken: "987654321:rotated-test-credential",
      botId: "987654321",
      botUsername: "RotatedTestBot",
    });

    expect(provider).toHaveBeenCalledTimes(2);
  });
});
