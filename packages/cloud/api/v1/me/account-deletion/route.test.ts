/** Verifies the account-deletion HTTP boundary with deterministic authentication and service mocks. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

class AccountDeletionConflictError extends Error {
  constructor(
    message: string,
    readonly code: "TRANSFER_REQUIRED" | "LIFECYCLE_RESERVATION_REQUIRED",
  ) {
    super(message);
  }
}

const requireRecentSessionUserWithOrg = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  steward_id: "steward-user-1",
}));
const requestAccountDeletion = mock(async () => ({
  request: {
    requestId: "33333333-3333-4333-8333-333333333333",
    status: "reserved",
  },
  statusCredential: "status-capability",
  recoveryCredential: "recovery-capability",
}));
const loggerError = mock(() => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireRecentSessionUserWithOrg,
}));
mock.module("@/lib/auth/browser-origin-policy", () => ({
  checkElizaMutatingRequestOrigin: () => ({ ok: true }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/account-deletion", () => ({
  AccountDeletionConflictError,
  getOpenAccountDeletionRequest: mock(async () => undefined),
  requestAccountDeletion,
  toAccountDeletionRequestDto: (request: Record<string, unknown>) => ({
    requestId: request.id,
    status: request.status,
    scheduledDeletionAt: (request.execute_after as Date).toISOString(),
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  requestAccountDeletion.mockClear();
  loggerError.mockClear();
});

describe("POST /api/v1/me/account-deletion", () => {
  test("requires an explicit DELETE confirmation", async () => {
    const response = await app.request(
      "/",
      { method: "POST", body: "{}" },
      {
        NODE_ENV: "test",
      },
    );
    expect(response.status).toBe(400);
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  test("schedules deletion for the authenticated Steward identity", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE" }),
      },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(202);
    expect(requestAccountDeletion).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      stewardUserId: "steward-user-1",
    });
  });

  test("returns the actionable service conflict code without claiming success", async () => {
    requestAccountDeletion.mockRejectedValueOnce(
      new AccountDeletionConflictError(
        "Transfer shared resources before deletion",
        "TRANSFER_REQUIRED",
      ),
    );
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE" }),
      },
      { NODE_ENV: "test" },
    );

    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Transfer shared resources before deletion",
      code: "TRANSFER_REQUIRED",
    });
  });

  test("does not log service messages that may contain account identifiers", async () => {
    requestAccountDeletion.mockRejectedValueOnce(
      new Error("provider failed for user@example.invalid"),
    );

    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE" }),
      },
      { NODE_ENV: "test" },
    );

    expect(response.status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(
      "[AccountDeletionRoute] Failed to schedule deletion",
      { errorCode: "Error" },
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "user@example.invalid",
    );
  });
});
