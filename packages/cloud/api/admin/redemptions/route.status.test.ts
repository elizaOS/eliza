/**
 * GET /api/admin/redemptions status identity.
 *
 * Stock develop treated unknown `status` tokens as the pending payout queue.
 * `status=complete` (missing d) and `status=Pending` silently listed pending
 * redemptions instead of 400. Canonical UI tokens and the `all` / `review`
 * aliases must keep working. Network / limit / search parsers stay untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const listForAdmin = mock(async () => []);
const countByStatusForAdmin = mock(async () => []);
const requireAdmin = mock(async () => ({
  user: { id: "admin-1" },
  role: "super_admin",
}));

mock.module("@/db/repositories/token-redemptions", () => ({
  tokenRedemptionsRepository: { listForAdmin, countByStatusForAdmin },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({ requireAdmin }));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ success: false, error: "internal_error" }, 500),
}));
mock.module("@/lib/services/token-redemption-secure", () => ({
  secureTokenRedemptionService: {},
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/admin/redemptions", route);

function listRedemptions(query = "") {
  return app.request(`/api/admin/redemptions${query}`);
}

const ALL_STATUSES = [
  "pending",
  "approved",
  "processing",
  "completed",
  "failed",
  "rejected",
  "expired",
] as const;

describe("GET /api/admin/redemptions status identity", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    listForAdmin.mockClear();
    countByStatusForAdmin.mockClear();
    listForAdmin.mockResolvedValue([]);
    countByStatusForAdmin.mockResolvedValue([]);
  });

  test("omitted status still lists the pending payout queue", async () => {
    const response = await listRedemptions();

    expect(response.status).toBe(200);
    expect(listForAdmin).toHaveBeenCalledWith(["pending"], 50);
  });

  test.each([...ALL_STATUSES])("status=%s lists that queue", async (status) => {
    const response = await listRedemptions(`?status=${status}`);

    expect(response.status).toBe(200);
    expect(listForAdmin).toHaveBeenCalledWith([status], 50);
  });

  test("status=all lists every known queue", async () => {
    const response = await listRedemptions("?status=all");

    expect(response.status).toBe(200);
    expect(listForAdmin).toHaveBeenCalledWith([...ALL_STATUSES], 50);
  });

  test("status=review keeps the pending-review alias", async () => {
    const response = await listRedemptions("?status=review");

    expect(response.status).toBe(200);
    expect(listForAdmin).toHaveBeenCalledWith(["pending"], 50);
  });

  test.each(["complete", "Pending", "cancelled", "foo", "1e2"])(
    "rejects status=%s before listForAdmin",
    async (status) => {
      const response = await listRedemptions(
        `?status=${encodeURIComponent(status)}`,
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Invalid status");
      expect(listForAdmin).not.toHaveBeenCalled();
      expect(countByStatusForAdmin).not.toHaveBeenCalled();
    },
  );
});
