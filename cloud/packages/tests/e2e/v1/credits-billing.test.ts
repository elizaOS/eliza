/**
 * E2E: Credits & Billing
 *
 * Tests credit balance queries, checkout session creation, and
 * app-level credit operations for the monetization flow.
 *
 * Note: Stripe checkout URLs are generated but NOT completed in tests.
 * We verify the API returns valid checkout URLs and session IDs.
 *
 * Requires: TEST_API_KEY env var pointing at a live Cloud account.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import { createTestApp, deleteTestApp, enableMonetization } from "../helpers/app-lifecycle";
import { readJson } from "../helpers/json-body";

setDefaultTimeout(30_000);

type CreditBalanceResponse = {
  balance: number;
};

type CheckoutResponse = {
  url: string;
  sessionId: string;
};

type AppCreditBalanceResponse = {
  success: boolean;
  balance: number;
  totalPurchased: number;
  totalSpent: number;
  isLow: boolean;
};

type AppCreditCheckoutResponse = CheckoutResponse & {
  success: boolean;
};

// ── Organization Credits ────────────────────────────────────────────
describe("Organization Credits", () => {
  test("GET /api/v1/credits/balance returns balance", async () => {
    const response = await api.get("/api/v1/credits/balance", {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<CreditBalanceResponse>(response);
    expect(typeof body.balance).toBe("number");
    expect(body.balance).toBeGreaterThanOrEqual(0);
  });

  test("GET /api/v1/credits/balance?fresh=true bypasses cache", async () => {
    const response = await api.get("/api/v1/credits/balance?fresh=true", {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<CreditBalanceResponse>(response);
    expect(typeof body.balance).toBe("number");
  });

  test("POST /api/v1/credits/checkout creates Stripe session", async () => {
    const response = await api.post(
      "/api/v1/credits/checkout",
      {
        credits: 10,
        success_url: "https://test.example.com/success",
        cancel_url: "https://test.example.com/cancel",
      },
      { authenticated: true },
    );

    if (response.status === 200) {
      const body = await readJson<CheckoutResponse>(response);
      expect(typeof body.url).toBe("string");
      expect(typeof body.sessionId).toBe("string");
      // Stripe checkout URLs start with https://checkout.stripe.com
      expect(body.url).toContain("stripe.com");
    } else {
      expect([400, 503]).toContain(response.status);
    }
  });

  test("POST /api/v1/credits/checkout validates amount", async () => {
    const response = await api.post(
      "/api/v1/credits/checkout",
      {
        credits: -1,
        success_url: "https://test.example.com/success",
        cancel_url: "https://test.example.com/cancel",
      },
      { authenticated: true },
    );
    expect(response.status).toBe(400);
  });

  test("credits balance requires auth", async () => {
    const response = await api.get("/api/v1/credits/balance");
    expect([401, 403]).toContain(response.status);
  });
});

// ── App-Level Credits ───────────────────────────────────────────────
describe("App Credits", () => {
  let appId: string;

  beforeAll(async () => {
    const { response, body } = await createTestApp();
    expect(response.status).toBe(200);
    appId = body.app.id;

    // Enable monetization so app credit features work
    await enableMonetization(appId, {
      inferenceMarkupPercentage: 25,
      purchaseSharePercentage: 10,
    });
  });

  afterAll(async () => {
    if (appId) {
      await deleteTestApp(appId).catch(() => {});
    }
  });

  test("GET /api/v1/app-credits/balance returns app credit balance", async () => {
    const response = await api.get(`/api/v1/app-credits/balance?app_id=${appId}`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<AppCreditBalanceResponse>(response);
    expect(body.success).toBe(true);
    expect(typeof body.balance).toBe("number");
    expect(typeof body.totalPurchased).toBe("number");
    expect(typeof body.totalSpent).toBe("number");
    expect(typeof body.isLow).toBe("boolean");
    // New app should have 0 balance
    expect(body.balance).toBe(0);
  });

  test("GET /api/v1/app-credits/balance accepts X-App-Id header", async () => {
    const response = await api.get("/api/v1/app-credits/balance", {
      authenticated: true,
      headers: { "X-App-Id": appId },
    });
    expect(response.status).toBe(200);

    const body = await readJson<Pick<AppCreditBalanceResponse, "success">>(response);
    expect(body.success).toBe(true);
  });

  test("POST /api/v1/app-credits/checkout creates app checkout session", async () => {
    const response = await api.post(
      "/api/v1/app-credits/checkout",
      {
        app_id: appId,
        amount: 5,
        success_url: "https://test.example.com/success",
        cancel_url: "https://test.example.com/cancel",
      },
      { authenticated: true },
    );

    // May succeed with Stripe or fail if Stripe not configured
    if (response.status === 200) {
      const body = await readJson<AppCreditCheckoutResponse>(response);
      expect(body.success).toBe(true);
      expect(typeof body.url).toBe("string");
      expect(typeof body.sessionId).toBe("string");
    } else {
      expect([400, 503]).toContain(response.status);
    }
  });

  test("POST /api/v1/app-credits/checkout validates app_id", async () => {
    const response = await api.post(
      "/api/v1/app-credits/checkout",
      {
        app_id: "not-a-uuid",
        amount: 5,
        success_url: "https://test.example.com/success",
        cancel_url: "https://test.example.com/cancel",
      },
      { authenticated: true },
    );
    expect(response.status).toBe(400);
  });

  test("app credits balance requires app_id", async () => {
    const response = await api.get("/api/v1/app-credits/balance", {
      authenticated: true,
    });
    // Should fail without app_id
    expect([400, 404]).toContain(response.status);
  });
});

// ── Credit Verification ─────────────────────────────────────────────
describe("Credit Verification", () => {
  test("GET /api/v1/credits/verify requires session_id param", async () => {
    const response = await api.get("/api/v1/credits/verify", {
      authenticated: true,
    });
    // Should fail without session_id query parameter
    expect([400, 404]).toContain(response.status);
  });

  test("GET /api/v1/app-credits/verify requires session_id param", async () => {
    const response = await api.get("/api/v1/app-credits/verify", {
      authenticated: true,
    });
    expect([400, 404]).toContain(response.status);
  });
});
