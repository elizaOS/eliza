/**
 * GET /api/admin/redemptions `network` is admin-redemption payout-rail
 * identity, not leftover tax on admin redemption status (already
 * fail-closed) or redemption quote pointsAmount. Stock develop passed
 * unknown tokens into `r.network !== networkFilter`, so
 * `network=SOLANA` / `ETH` silently returned an empty payout queue.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

function redemptionRow(overrides: {
  id: string;
  network: string;
  user_id?: string;
  payout_address?: string;
  user_email?: string;
}) {
  return {
    id: overrides.id,
    network: overrides.network,
    user_id: overrides.user_id ?? "u1",
    payout_address: overrides.payout_address ?? "0xabc",
    user_email: overrides.user_email ?? "a@example.com",
    app_id: null,
    app_name: null,
    points_amount: "0",
    usd_value: "0",
    eliza_amount: "0",
    eliza_price_usd: "0",
    status: "pending",
    requires_review: false,
    tx_hash: null,
    failure_reason: null,
    retry_count: 0,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    completed_at: null,
    metadata: null,
  };
}

const listForAdmin = mock(async () => [
  redemptionRow({
    id: "r-sol",
    network: "solana",
    payout_address: "So11111111111111111111111111111111111111112",
  }),
  redemptionRow({
    id: "r-base",
    network: "base",
    user_id: "u2",
    user_email: "b@example.com",
  }),
]);
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

describe("GET /api/admin/redemptions payout-rail identity", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    listForAdmin.mockClear();
    countByStatusForAdmin.mockClear();
  });

  test.each(["", "?network="])(
    "accepts %s as the unfiltered payout-rail catalog",
    async (query) => {
      const response = await listRedemptions(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { redemptions: { id: string }[] };
      expect(body.redemptions.map((row) => row.id)).toEqual([
        "r-sol",
        "r-base",
      ]);
      expect(listForAdmin).toHaveBeenCalledTimes(1);
    },
  );

  test("accepts network=solana as the Solana payout-rail catalog", async () => {
    const response = await listRedemptions("?network=solana");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { redemptions: { id: string }[] };
    expect(body.redemptions.map((row) => row.id)).toEqual(["r-sol"]);
    expect(listForAdmin).toHaveBeenCalledTimes(1);
  });

  test("accepts network=bsc as the BNB payout-rail alias", async () => {
    listForAdmin.mockResolvedValueOnce([
      redemptionRow({
        id: "r-bnb",
        network: "bnb",
        user_id: "u3",
        payout_address: "0xbnb",
        user_email: "c@example.com",
      }),
    ]);
    const response = await listRedemptions("?network=bsc");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { redemptions: { id: string }[] };
    expect(body.redemptions.map((row) => row.id)).toEqual(["r-bnb"]);
    expect(listForAdmin).toHaveBeenCalledTimes(1);
  });

  test.each(["SOLANA", "ETH", "polygon", "foo", "1e2"])(
    "rejects network=%s before listForAdmin",
    async (token) => {
      const response = await listRedemptions(
        `?network=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Invalid network");
      expect(listForAdmin).not.toHaveBeenCalled();
      expect(countByStatusForAdmin).not.toHaveBeenCalled();
    },
  );
});
