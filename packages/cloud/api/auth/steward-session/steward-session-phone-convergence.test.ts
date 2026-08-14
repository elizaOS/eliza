/** Verifies SMS session sync proves phone ownership before Cloud account convergence. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const emitAudit = mock(async () => undefined);
const verifyStewardTokenCached = mock(async () => ({
  userId: "steward-user-1",
  tenantId: "personal-steward-user-1",
  expiration: Math.floor(Date.now() / 1000) + 900,
  issuedAt: Math.floor(Date.now() / 1000) - 10,
}));
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
  verifyStewardTokenCached.mockClear();
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
      verifiedPhone: "+14155552671",
    });
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
