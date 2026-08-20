import { beforeEach, describe, expect, mock, test } from "bun:test";

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

mock.module("@/lib/auth/workers-hono-auth", () => ({ requireUserWithOrg }));
mock.module("@/lib/auth/browser-origin-policy", () => ({
  checkElizaMutatingRequestOrigin: () => ({ ok: true }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/account-deletion", () => ({
  AccountDeletionConflictError: class AccountDeletionConflictError extends Error {},
  getOpenAccountDeletionRequest: mock(async () => undefined),
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

beforeEach(() => requestAccountDeletion.mockClear());

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
});
