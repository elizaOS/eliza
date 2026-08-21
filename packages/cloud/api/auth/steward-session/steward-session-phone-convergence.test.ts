/** Verifies SMS session sync proves phone ownership before Cloud account convergence. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const emitAudit = mock(async () => undefined);
const baseStewardClaims: {
  userId: string;
  tenantId: string;
  expiration: number;
  issuedAt: number;
  telegramId?: string;
} = {
  userId: "steward-user-1",
  tenantId: "personal-steward-user-1",
  expiration: Math.floor(Date.now() / 1000) + 900,
  issuedAt: Math.floor(Date.now() / 1000) - 10,
};
const verifyStewardTokenCached = mock(async () => baseStewardClaims);
type PhoneOwnership =
  | { status: "verified"; phoneNumber: string }
  | { status: "not_linked" };
const verifyStewardBearerPhone = mock(
  async (): Promise<PhoneOwnership> => ({
    status: "verified",
    phoneNumber: "+14155552671",
  }),
);
const syncUserFromSteward = mock(async () => ({
  id: "cloud-user-1",
  organization_id: "org-1",
  initialCreditsGranted: false,
  initialFreeCreditsUsd: 0,
}));

class MockStewardPhoneOwnershipError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class MockStewardPhoneAccountConflictError extends Error {}
class MockStewardTelegramAccountClaimError extends Error {}

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitAudit }),
}));

mock.module("@/lib/auth/steward-client", () => ({
  verifyStewardTokenCached,
}));

mock.module("@/lib/services/steward-client", () => ({
  StewardPhoneOwnershipError: MockStewardPhoneOwnershipError,
  verifyStewardBearerPhone,
}));

mock.module("@/lib/services/sso-bridge-codes", () => ({
  isBlockedBySsoBridgeLogout: mock(async () => false),
}));

mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  StewardPhoneAccountConflictError: MockStewardPhoneAccountConflictError,
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
};

async function post(body: unknown): Promise<Response> {
  const app = new Hono();
  app.route("/api/auth/steward-session", route);
  return await app.fetch(
    new Request("https://api-staging.elizacloud.ai/api/auth/steward-session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://staging.elizacloud.ai",
      },
      body: JSON.stringify(body),
    }),
    ENV,
  );
}

beforeEach(() => {
  emitAudit.mockClear();
  verifyStewardTokenCached.mockReset();
  verifyStewardTokenCached.mockResolvedValue(baseStewardClaims);
  verifyStewardBearerPhone.mockReset();
  verifyStewardBearerPhone.mockResolvedValue({
    status: "verified",
    phoneNumber: "+14155552671",
  });
  syncUserFromSteward.mockClear();
});

describe("POST /api/auth/steward-session phone convergence", () => {
  test("passes only the server-verified phone into the existing sync authority", async () => {
    const response = await post({
      token: "sms-session-token",
      refreshToken: "sms-refresh-token",
      verifiedPhone: "+1 (415) 555-2671",
    });

    expect(response.status).toBe(200);
    expect(verifyStewardBearerPhone).toHaveBeenCalledWith({
      env: ENV,
      bearerToken: "sms-session-token",
      tenantId: "personal-steward-user-1",
      phoneNumber: "+1 (415) 555-2671",
    });
    expect(syncUserFromSteward).toHaveBeenCalledWith({
      stewardUserId: "steward-user-1",
      email: undefined,
      walletAddress: undefined,
      walletChainType: undefined,
      verifiedTelegramId: undefined,
      verifiedPhone: "+14155552671",
      telegramContinuation: undefined,
    });
  });

  test("passes an opaque Telegram account claim into pre-creation convergence", async () => {
    const response = await post({
      token: "steward-session-token",
      telegramContinuation: "opaque-telegram-claim-token",
      telegramClaimConfirmation: "explicit",
    });

    expect(response.status).toBe(200);
    expect(syncUserFromSteward).toHaveBeenCalledWith({
      stewardUserId: "steward-user-1",
      email: undefined,
      walletAddress: undefined,
      walletChainType: undefined,
      verifiedTelegramId: undefined,
      verifiedPhone: undefined,
      telegramContinuation: "opaque-telegram-claim-token",
    });
  });

  test("passes the signed Telegram id into Cloud account convergence", async () => {
    verifyStewardTokenCached.mockResolvedValueOnce({
      ...baseStewardClaims,
      telegramId: "123456789",
    });

    const response = await post({ token: "telegram-session-token" });

    expect(response.status).toBe(200);
    expect(syncUserFromSteward).toHaveBeenCalledWith({
      stewardUserId: "steward-user-1",
      email: undefined,
      walletAddress: undefined,
      walletChainType: undefined,
      verifiedTelegramId: "123456789",
      verifiedPhone: undefined,
      telegramContinuation: undefined,
    });
  });

  test("rejects claim authority without the explicit confirmation contract", async () => {
    const response = await post({
      token: "steward-session-token",
      telegramContinuation: "opaque-telegram-claim-token",
    });

    expect(response.status).toBe(409);
    expect(syncUserFromSteward).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rejects malformed Telegram claims before Steward sync", async () => {
    const response = await post({
      token: "steward-session-token",
      telegramContinuation: "platform:telegram:123456789",
      telegramClaimConfirmation: "explicit",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "telegram_claim_conflict",
    });
    expect(syncUserFromSteward).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("returns an explicit conflict and no cookie when Telegram ownership disagrees", async () => {
    syncUserFromSteward.mockRejectedValueOnce(
      new MockStewardTelegramAccountClaimError("telegram conflict"),
    );

    const response = await post({
      token: "steward-session-token",
      telegramContinuation: "opaque-telegram-claim-token",
      telegramClaimConfirmation: "explicit",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "telegram_claim_conflict",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rejects a phone absent from the bearer's Steward accounts", async () => {
    verifyStewardBearerPhone.mockResolvedValue({ status: "not_linked" });

    const response = await post({
      token: "sms-session-token",
      verifiedPhone: "+14155552671",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "verified_phone_mismatch",
    });
    expect(syncUserFromSteward).not.toHaveBeenCalled();
  });

  test("keeps Steward outages distinct and retryable", async () => {
    verifyStewardBearerPhone.mockRejectedValue(
      new MockStewardPhoneOwnershipError("upstream_unavailable"),
    );

    const response = await post({
      token: "sms-session-token",
      verifiedPhone: "+14155552671",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "steward_upstream_unavailable",
    });
    expect(syncUserFromSteward).not.toHaveBeenCalled();
  });

  test("returns an explicit conflict when a mature account blocks convergence", async () => {
    syncUserFromSteward.mockRejectedValueOnce(
      new MockStewardPhoneAccountConflictError("phone conflict"),
    );

    const response = await post({
      token: "sms-session-token",
      verifiedPhone: "+14155552671",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "verified_phone_conflict",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
