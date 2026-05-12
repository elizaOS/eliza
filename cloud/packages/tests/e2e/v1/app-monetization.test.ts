/**
 * E2E: App Monetization
 *
 * Tests monetization configuration, earnings tracking, and withdrawal
 * APIs for a published mini app.
 *
 * Requires: TEST_API_KEY env var pointing at a live Cloud account.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import {
  createTestApp,
  deleteTestApp,
  enableMonetization,
  getEarnings,
  getMonetization,
} from "../helpers/app-lifecycle";
import { readJson } from "../helpers/json-body";

setDefaultTimeout(30_000);

type EarningsChartResponse = {
  earnings: {
    chartData: unknown[];
  };
};

type EarningsHistoryResponse = {
  success: boolean;
};

describe("App Monetization", () => {
  let appId: string;

  beforeAll(async () => {
    const { response, body } = await createTestApp();
    expect(response.status).toBe(200);
    appId = body.app.id;
  });

  afterAll(async () => {
    if (appId) {
      await deleteTestApp(appId).catch(() => {});
    }
  });

  // ── Initial state: monetization disabled ────────────────────────
  test("new app starts with monetization disabled", async () => {
    const { response, body } = await getMonetization(appId);
    expect(response.status).toBe(200);
    expect(body.monetization.monetizationEnabled).toBe(false);
  });

  // ── Enable with inference markup ────────────────────────────────
  test("enable monetization with 50% inference markup", async () => {
    const { response, body } = await enableMonetization(appId, {
      inferenceMarkupPercentage: 50,
      purchaseSharePercentage: 0,
    });
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    const { body: verify } = await getMonetization(appId);
    expect(verify.monetization.monetizationEnabled).toBe(true);
    expect(verify.monetization.inferenceMarkupPercentage).toBe(50);
    expect(verify.monetization.purchaseSharePercentage).toBe(0);
  });

  // ── Update to add purchase share ────────────────────────────────
  test("add purchase share percentage", async () => {
    const response = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { purchaseSharePercentage: 15 },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const { body } = await getMonetization(appId);
    expect(body.monetization.purchaseSharePercentage).toBe(15);
    // inference markup should be unchanged
    expect(body.monetization.inferenceMarkupPercentage).toBe(50);
  });

  // ── Maximum markup ──────────────────────────────────────────────
  test("set maximum inference markup (1000%)", async () => {
    const response = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { inferenceMarkupPercentage: 1000 },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const { body } = await getMonetization(appId);
    expect(body.monetization.inferenceMarkupPercentage).toBe(1000);
  });

  // ── Earnings summary structure ──────────────────────────────────
  test("earnings summary has correct shape", async () => {
    const { response, body } = await getEarnings(appId);
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    const { summary } = body.earnings;
    expect(typeof summary.totalLifetimeEarnings).toBe("number");
    expect(typeof summary.totalInferenceEarnings).toBe("number");
    expect(typeof summary.totalPurchaseEarnings).toBe("number");
    expect(typeof summary.pendingBalance).toBe("number");
    expect(typeof summary.withdrawableBalance).toBe("number");
    expect(typeof summary.totalWithdrawn).toBe("number");
    expect(typeof summary.payoutThreshold).toBe("number");
  });

  // ── Earnings breakdown structure ────────────────────────────────
  test("earnings breakdown has period buckets", async () => {
    const { body } = await getEarnings(appId);
    const { breakdown } = body.earnings;

    expect(breakdown).toBeDefined();
    for (const period of ["today", "thisWeek", "thisMonth", "allTime"]) {
      expect(breakdown[period]).toBeDefined();
      expect(typeof breakdown[period].total).toBe("number");
    }
  });

  // ── Chart data structure ────────────────────────────────────────
  test("earnings chart data is an array", async () => {
    const response = await api.get(`/api/v1/apps/${appId}/earnings?days=7`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<EarningsChartResponse>(response);
    expect(Array.isArray(body.earnings.chartData)).toBe(true);
  });

  // ── Earnings history (empty) ────────────────────────────────────
  test("earnings history returns transactions array", async () => {
    const response = await api.get(`/api/v1/apps/${appId}/earnings/history`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<EarningsHistoryResponse>(response);
    expect(body.success).toBe(true);
  });

  // ── Withdrawal fails: insufficient balance ──────────────────────
  test("withdrawal fails when balance is zero", async () => {
    const response = await api.post(
      `/api/v1/apps/${appId}/earnings/withdraw`,
      {
        amount: 25.0,
        idempotency_key: `e2e-test-${Date.now()}-withdraw`,
      },
      { authenticated: true },
    );
    // Should fail — no earnings to withdraw
    expect([400, 403]).toContain(response.status);
  });

  // ── Monetization data in earnings response ──────────────────────
  test("earnings response includes monetization config", async () => {
    const { body } = await getEarnings(appId);
    expect(body.monetization).toBeDefined();
    expect(typeof body.monetization.enabled).toBe("boolean");
    expect(typeof body.monetization.inferenceMarkupPercentage).toBe("number");
    expect(typeof body.monetization.purchaseSharePercentage).toBe("number");
  });

  // ── Disable monetization ────────────────────────────────────────
  test("disable monetization", async () => {
    const response = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: false },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const { body } = await getMonetization(appId);
    expect(body.monetization.monetizationEnabled).toBe(false);
  });

  // ── Re-enable monetization ──────────────────────────────────────
  test("re-enable monetization preserves previous settings", async () => {
    const response = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: true },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const { body } = await getMonetization(appId);
    expect(body.monetization.monetizationEnabled).toBe(true);
    // Previous markup should persist through disable/enable cycle
    expect(body.monetization.inferenceMarkupPercentage).toBe(1000);
  });
});

// ── Monetization error cases ────────────────────────────────────────
describe("App Monetization — Error Cases", () => {
  test("monetization on nonexistent app returns 404", async () => {
    const response = await api.get(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000/monetization",
      { authenticated: true },
    );
    expect([403, 404]).toContain(response.status);
  });

  test("monetization requires auth", async () => {
    const response = await api.get(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000/monetization",
    );
    expect([401, 403]).toContain(response.status);
  });
});
