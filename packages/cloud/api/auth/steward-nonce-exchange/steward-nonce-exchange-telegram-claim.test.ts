/** Verifies OAuth code exchange carries Telegram claim authority into Cloud sync. */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const nativeFetch = globalThis.fetch;
const upstreamFetch = mock(async () =>
  Response.json({
    ok: true,
    token: "steward-access-token",
    refreshToken: "steward-refresh-token",
  }),
);
const verifyStewardTokenCached = mock(async () => ({
  userId: "steward-user-1",
  tenantId: "elizacloud",
  expiration: Math.floor(Date.now() / 1000) + 900,
}));
const syncUserFromSteward = mock(async () => ({
  id: "telegram-user-1",
  organization_id: "telegram-org-1",
}));

class MockStewardTelegramAccountClaimError extends Error {}

mock.module("@/lib/auth/steward-client", () => ({
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS: 5_000,
  verifyStewardTokenCached,
}));

mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  StewardTelegramAccountClaimError: MockStewardTelegramAccountClaimError,
  syncUserFromSteward,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: route } = await import("./route");

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  STEWARD_SESSION_SECRET: "test-secret",
  STEWARD_API_URL: "https://steward.example",
  STEWARD_TENANT_ID: "elizacloud",
};

async function post(body: unknown): Promise<Response> {
  const app = new Hono();
  app.route("/api/auth/steward-nonce-exchange", route);
  return app.fetch(
    new Request(
      "https://api-staging.elizacloud.ai/api/auth/steward-nonce-exchange",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://staging.elizacloud.ai",
        },
        body: JSON.stringify(body),
      },
    ),
    ENV,
  );
}

beforeEach(() => {
  upstreamFetch.mockClear();
  upstreamFetch.mockResolvedValue(
    Response.json({
      ok: true,
      token: "steward-access-token",
      refreshToken: "steward-refresh-token",
    }),
  );
  globalThis.fetch = upstreamFetch as unknown as typeof fetch;
  verifyStewardTokenCached.mockClear();
  syncUserFromSteward.mockReset();
  syncUserFromSteward.mockResolvedValue({
    id: "telegram-user-1",
    organization_id: "telegram-org-1",
  });
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
});

describe("POST /api/auth/steward-nonce-exchange Telegram convergence", () => {
  test("passes the opaque claim into sync before planting cookies", async () => {
    const response = await post({
      code: "one-time-code",
      redirectUri: "https://cloud.eliza.app/login",
      telegramContinuation: "opaque-telegram-claim-token",
    });

    expect(response.status).toBe(200);
    expect(syncUserFromSteward).toHaveBeenCalledWith({
      stewardUserId: "steward-user-1",
      email: undefined,
      walletAddress: undefined,
      walletChainType: undefined,
      telegramContinuation: "opaque-telegram-claim-token",
    });
    expect(response.headers.get("set-cookie") ?? "").toContain(
      "steward-token-staging=steward-access-token",
    );
  });

  test("returns a conflict without cookies when the account cannot be claimed", async () => {
    syncUserFromSteward.mockRejectedValueOnce(
      new MockStewardTelegramAccountClaimError("ownership conflict"),
    );

    const response = await post({
      code: "one-time-code",
      redirectUri: "https://cloud.eliza.app/login",
      telegramContinuation: "opaque-telegram-claim-token",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "telegram_claim_conflict",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rejects a guessable platform session before consuming the OAuth code", async () => {
    const response = await post({
      code: "one-time-code",
      redirectUri: "https://cloud.eliza.app/login",
      telegramContinuation: "platform:telegram:123456789",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "telegram_claim_conflict",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(syncUserFromSteward).not.toHaveBeenCalled();
  });
});
