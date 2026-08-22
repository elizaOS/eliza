/** Verifies the account-deletion HTTP boundary with deterministic authentication and service mocks. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

class AccountDeletionConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ACCOUNT_UNAVAILABLE"
      | "ANONYMOUS_ACCOUNT"
      | "TRANSFER_REQUIRED"
      | "LIFECYCLE_RESERVATION_REQUIRED",
  ) {
    super(message);
  }
}

const requireUserWithOrg = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  steward_id: "steward-user-1",
}));
const requestAccountDeletion = mock(async () => ({
  id: "33333333-3333-4333-8333-333333333333",
  status: "scheduled",
  requested_at: new Date("2026-08-19T00:00:00Z"),
  execute_after: new Date("2026-09-18T00:00:00Z"),
  identity_deactivated_at: new Date("2026-08-19T00:00:00Z"),
  completed_at: null,
}));
const getAccountDeletionStatus = mock(async () => ({
  state: "lifecycle_unavailable" as const,
  request: null,
  code: "LIFECYCLE_RESERVATION_REQUIRED" as const,
  message: "Lifecycle reservation required",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({ requireUserWithOrg }));
mock.module("@/lib/auth/browser-origin-policy", () => ({
  checkElizaMutatingRequestOrigin: () => ({ ok: true }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/account-deletion", () => ({
  AccountDeletionConflictError,
  getAccountDeletionStatus,
  requestAccountDeletion,
  toAccountDeletionRequestDto: (request: Record<string, unknown>) => ({
    requestId: request.id,
    status: request.status,
    scheduledDeletionAt: (request.execute_after as Date).toISOString(),
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  getAccountDeletionStatus.mockClear();
  requestAccountDeletion.mockClear();
});

describe("GET /api/v1/me/account-deletion", () => {
  test("returns the side-effect-free lifecycle admission projection", async () => {
    const response = await app.request("/", undefined, { NODE_ENV: "test" });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message: "Lifecycle reservation required",
    });
    expect(getAccountDeletionStatus).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
    });
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  test("returns a conflict instead of surfacing a receipt for an unavailable account", async () => {
    getAccountDeletionStatus.mockRejectedValueOnce(
      new AccountDeletionConflictError(
        "Account is no longer available",
        "ACCOUNT_UNAVAILABLE",
      ),
    );

    const response = await app.request("/", undefined, { NODE_ENV: "test" });

    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Account is no longer available",
      code: "ACCOUNT_UNAVAILABLE",
    });
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });
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

  test("passes the authenticated identity to the fail-closed service", async () => {
    requestAccountDeletion.mockRejectedValueOnce(
      new AccountDeletionConflictError(
        "Lifecycle reservation required",
        "LIFECYCLE_RESERVATION_REQUIRED",
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
    expect(requestAccountDeletion).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      stewardUserId: "steward-user-1",
    });
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Lifecycle reservation required",
      code: "LIFECYCLE_RESERVATION_REQUIRED",
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
});
