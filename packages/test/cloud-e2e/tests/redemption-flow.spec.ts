/**
 * Creator payout (redemption) lifecycle — the highest-value untested surface.
 *
 * Drives the REAL redemption path end to end against the booted stack:
 *   seed redeemable earnings + ≥3 TWAP price samples
 *     → GET /api/v1/redemptions/balance
 *     → GET /api/v1/redemptions/quote   (real TWAP USD→token quote)
 *     → POST /api/v1/redemptions        (atomic available→pending lock, ledger row)
 *     → GET /api/v1/redemptions         (list contains it)
 *     → admin POST /api/admin/redemptions { action: approve }
 *     → GET /api/v1/redemptions/status
 *
 * Permission assertions (the "permissioned properly" requirement):
 *   - a different user cannot read this user's redemption (IDOR → 404)
 *   - a non-admin cannot approve/reject (403)
 *
 * The on-chain transfer itself (payout-processor) needs hot-wallet keys and is
 * covered by the gated anvil-fork test; here we verify everything up to and
 * including admin approval, which is where money leaves the user's control.
 */
import { randomUUID } from "node:crypto";
import { seedTestUser } from "../src/fixtures/seed";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

const PAYOUT_ADDRESS = "0x1111111111111111111111111111111111111111";

interface QuoteResponse {
  success?: boolean;
  quote?: { usdValue?: number; elizaAmount?: number; elizaPriceUsd?: number };
}
interface CreateRedemptionResponse {
  success?: boolean;
  redemptionId?: string;
  quote?: { usdValue?: number; requiresReview?: boolean };
  error?: string;
}
interface ListRedemptionsResponse {
  success?: boolean;
  redemptions?: Array<{ id: string; status: string; usdValue: number }>;
}

test.describe("creator payout / redemption lifecycle", () => {
  test("seed earnings → quote → request → admin approve, with IDOR + non-admin denials", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    const me = authedClient(api, seededUser.apiKey);

    // ---- Seed real redeemable earnings ($5) for the creator ----
    const { redeemableEarningsService } = await import(
      "@elizaos/cloud-shared/lib/services/redeemable-earnings"
    );
    const earn = await redeemableEarningsService.addEarnings({
      userId: seededUser.userId,
      amount: 5,
      source: "app_owner_revenue_share",
      sourceId: `redemption-test-${Date.now().toString(36)}`,
      description: "seed earnings for redemption e2e",
    });
    expect(earn.success).toBe(true);

    // ---- Seed ≥3 TWAP price samples (within the 15-min window, low volatility) ----
    const { twapPriceOracle } = await import(
      "@elizaos/cloud-shared/lib/services/twap-price-oracle"
    );
    for (const price of [0.02, 0.02, 0.0201, 0.0199]) {
      await twapPriceOracle.recordPriceSample("base", price, "e2e-seed");
    }

    // ---- Balance ----
    const balance = await me<{
      success?: boolean;
      balance?: { availableBalance?: number };
    }>("GET", "/api/v1/redemptions/balance");
    expect(balance.status).toBe(200);

    // ---- Quote (real TWAP USD→token) ----
    const quote = await me<QuoteResponse>(
      "GET",
      "/api/v1/redemptions/quote?network=base&pointsAmount=100",
    );
    expect(quote.status, "quote returns 200 once ≥3 samples exist").toBe(200);
    expect(
      quote.json.quote?.usdValue,
      "100 points quotes at $1.00",
    ).toBeCloseTo(1, 2);
    expect(
      (quote.json.quote?.elizaAmount ?? 0) > 0,
      "quote yields a positive token amount",
    ).toBe(true);

    // ---- Request redemption (atomic available→pending) ----
    const create = await me<CreateRedemptionResponse>(
      "POST",
      "/api/v1/redemptions",
      {
        pointsAmount: 100,
        network: "base",
        payoutAddress: PAYOUT_ADDRESS,
        idempotencyKey: randomUUID(),
      },
    );
    console.log(
      `[redemption] create status=${create.status} body=${JSON.stringify(create.json)}`,
    );
    expect(create.status, "redemption created").toBe(200);
    expect(create.json.success).toBe(true);
    const redemptionId = create.json.redemptionId;
    expect(redemptionId, "redemptionId returned").toBeTruthy();

    // ---- List contains it ----
    const list = await me<ListRedemptionsResponse>(
      "GET",
      "/api/v1/redemptions?limit=10",
    );
    expect(list.status).toBe(200);
    expect(
      list.json.redemptions?.some((r) => r.id === redemptionId),
      "redemption appears in the owner's list",
    ).toBe(true);

    // ---- IDOR: a different user cannot read this redemption ----
    const other = await seedTestUser({
      slug: `other-${Date.now().toString(36)}`,
    });
    const stranger = authedClient(api, other.apiKey);
    const idor = await stranger("GET", `/api/v1/redemptions/${redemptionId}`);
    expect([403, 404], "cross-user redemption read is denied").toContain(
      idor.status,
    );

    // ---- Non-admin cannot approve ----
    const nonAdminApprove = await stranger("POST", "/api/admin/redemptions", {
      redemptionId,
      action: "approve",
    });
    expect([401, 403], "non-admin cannot approve a payout").toContain(
      nonAdminApprove.status,
    );

    // ---- Admin approves. Admin status is granted to @elizalabs.ai accounts
    //      (adminService.getAdminStatusForUser → super_admin), so seed one. ----
    const suffix = Date.now().toString(36);
    const adminUser = await seedTestUser({
      slug: `admin-${suffix}`,
      email: `admin-${suffix}@elizalabs.ai`,
    });
    const admin = authedClient(api, adminUser.apiKey);
    const approve = await admin<{ success?: boolean }>(
      "POST",
      "/api/admin/redemptions",
      {
        redemptionId,
        action: "approve",
      },
    );
    console.log(
      `[redemption] approve status=${approve.status} body=${JSON.stringify(approve.json)}`,
    );
    expect(approve.status, "admin approve succeeds").toBe(200);
    expect(approve.json.success).toBe(true);

    // ---- Status endpoint reachable ----
    const status = await me("GET", "/api/v1/redemptions/status");
    expect(status.status).toBe(200);
  });
});
