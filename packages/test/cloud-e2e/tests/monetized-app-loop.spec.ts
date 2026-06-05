/**
 * Monetized-app loop smoke (cloud:mock).
 *
 * Proves the autonomous monetized-app loop end to end against the booted mock
 * stack:
 *   seed org (1000 credits) → apps.create → apps.monetization.update →
 *   domains.check → domains.buy (Cloudflare registrar stub, real credit debit)
 *   → record inference-markup earnings → survival-economics decision
 *   (computeContainerBillingPlan: earnings pay the daily container bill so an
 *   earning agent stays alive; a broke agent hits the shutdown path) →
 *   draw earnings down to fund hosting.
 *
 * Load-bearing invariants (exact, not smoke):
 *   - domain debit: 1099¢ wholesale + ceil(1099*3600/10000)=396¢ margin =
 *     1495¢ → org balance 1000 - 14.95 = 985.05 (tolerance < $0.01).
 *   - buy response: success && verified.
 *   - earnings ledger: $5 available after one addEarnings.
 *   - billing split: earnings (0 credits) → "billed" from earnings; no
 *     earnings + no credits → "insufficient" (fail-closed shutdown path).
 *
 * Uses the `stack` + `seededUser` fixtures so we hit stack.urls.api (not a
 * hardcoded port) and the seed fixture guarantees DATABASE_URL points at the
 * running PGlite bridge before the direct cloud-shared service calls run.
 */

import { computeContainerBillingPlan } from "@elizaos/cloud-shared/lib/services/container-billing-policy";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import type { CreditBalanceResponse } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { expect, test } from "../src/helpers/test-fixtures";

const DAILY_CONTAINER_COST_USD = 0.67;

/** apps.create returns { success, app: <App>, apiKey, ... }; we only read id. */
interface CreateAppResponse {
  success?: boolean;
  app?: { id?: string };
}

/** domains.buy success envelope (see cloud-api .../domains/buy/route.ts). */
interface DomainBuyResponse {
  success?: boolean;
  verified?: boolean;
  debited?: { totalUsdCents?: number; currency?: string };
}

test.describe("monetized-app loop", () => {
  test("seed → create → monetize → buy domain → earn → survive", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    const apiKey = seededUser.apiKey;

    const authedJson = async <T>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: T }> => {
      const res = await fetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-API-Key": apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = (await res.json()) as T;
      return { status: res.status, json };
    };

    // 0. Fail legibly if the stack isn't up before any loop step runs.
    const health = await fetch(`${api}/api/health`);
    expect(health.status, "stack /api/health must be reachable").toBe(200);

    // Starting balance: the seed fixture funds the org with 1000 credits.
    const startBalance = await authedJson<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(startBalance.status).toBe(200);
    expect(startBalance.json.balance).toBeCloseTo(1000, 2);

    // 1. Create the app.
    const created = await authedJson<CreateAppResponse>(
      "POST",
      "/api/v1/apps",
      {
        name: `Loop App ${Date.now().toString(36)}`,
        app_url: "https://placeholder.invalid",
        skipGitHubRepo: true,
      },
    );
    expect([200, 201]).toContain(created.status);
    const appId = created.json.app?.id;
    expect(appId, "apps.create must return an app id").toBeTruthy();

    // 2. Enable monetization (inference markup + purchase share).
    const monetization = await authedJson(
      "PUT",
      `/api/v1/apps/${appId}/monetization`,
      {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 100,
        purchaseSharePercentage: 10,
      },
    );
    expect([200, 201]).toContain(monetization.status);

    // 3. Buy a custom domain (Cloudflare registrar stub) — debits real credits.
    const domain = `loop-${Date.now().toString(36)}.com`;
    const check = await authedJson(
      "POST",
      `/api/v1/apps/${appId}/domains/check`,
      { domain },
    );
    expect([200, 201]).toContain(check.status);

    const buy = await authedJson<DomainBuyResponse>(
      "POST",
      `/api/v1/apps/${appId}/domains/buy`,
      { domain },
    );
    expect([200, 201]).toContain(buy.status);
    expect(buy.json.success, "domain buy must succeed").toBe(true);
    expect(buy.json.verified, "domain must be registered + attached").toBe(
      true,
    );

    // Exact domain-markup math: $10.99 wholesale + $3.96 margin = $14.95 off
    // the 1000-credit balance → 985.05 (< $0.01 tolerance).
    const afterBuy = await authedJson<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(afterBuy.status).toBe(200);
    expect(
      Math.abs(afterBuy.json.balance - 985.05),
      "domain debit must be exactly $14.95",
    ).toBeLessThan(0.01);

    // 4. Record inference-markup earnings for the app owner ($5 ledger entry).
    const earn = await redeemableEarningsService.addEarnings({
      userId: seededUser.userId,
      amount: 5,
      source: "app_owner_revenue_share",
      sourceId: appId ?? "",
      description: "simulated inference markup",
    });
    expect(earn.success).toBe(true);

    const earnings = await redeemableEarningsService.getBalance(
      seededUser.userId,
    );
    expect(
      earnings?.availableBalance,
      "exactly $5 redeemable after one addEarnings",
    ).toBe(5);

    // 5. Survival economics: the exact pure policy the container-billing cron
    //    uses. Earnings + ZERO org credits → bill paid from earnings (agent
    //    survives); no earnings + no credits → "insufficient" (shutdown path).
    const survives = computeContainerBillingPlan({
      dailyCost: DAILY_CONTAINER_COST_USD,
      currentBalance: 0,
      ownerEarningsAvailable: earnings?.availableBalance ?? 0,
      payAsYouGoFromEarnings: true,
    });
    expect(survives.action).toBe("billed");
    expect(survives.fromEarnings).toBeGreaterThanOrEqual(
      DAILY_CONTAINER_COST_USD - 1e-9,
    );

    const broke = computeContainerBillingPlan({
      dailyCost: DAILY_CONTAINER_COST_USD,
      currentBalance: 0,
      ownerEarningsAvailable: 0,
      payAsYouGoFromEarnings: true,
    });
    expect(broke.action).toBe("insufficient");

    // 6. Draw the earnings down to fund the daily container bill.
    const convert = await redeemableEarningsService.convertToCredits({
      userId: seededUser.userId,
      amount: DAILY_CONTAINER_COST_USD,
      organizationId: seededUser.organizationId,
      description: "survival: fund container hosting from earnings",
    });
    expect(convert.success).toBe(true);
  });
});
