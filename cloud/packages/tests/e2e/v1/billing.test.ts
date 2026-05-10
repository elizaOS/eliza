import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import { type JsonValue, readJson } from "../helpers/json-body";

/**
 * Billing & Payments API E2E Tests
 *
 * Topup routes call Stripe, so we use a longer timeout.
 */
setDefaultTimeout(15_000);

describe("Billing API", () => {
  test("GET /api/v1/billing/settings requires auth", async () => {
    const response = await api.get("/api/v1/billing/settings");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/credits/summary requires auth", async () => {
    const response = await api.get("/api/v1/credits/summary");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/credits/summary returns billing info", async () => {
    const response = await api.get("/api/v1/credits/summary", {
      authenticated: true,
    });
    expect(response.status).toBe(200);
    const body = await readJson<JsonValue>(response);
    expect(body).toBeTruthy();
  });
});

describe("Topup Routes", () => {
  const amounts = [10, 50, 100] as const;

  for (const amount of amounts) {
    test(`POST /api/v1/topup/${amount} fails closed without payment details`, async () => {
      const response = await api.post(`/api/v1/topup/${amount}`);
      expect([400, 401, 403, 402]).toContain(response.status);
    });
  }

  test("POST /api/auto-top-up/trigger requires auth", async () => {
    const response = await api.post("/api/auto-top-up/trigger");
    expect([401, 403, 402]).toContain(response.status);
  });
});

describe("Crypto Payments API", () => {
  test("POST /api/crypto/payments requires auth", async () => {
    const response = await api.post("/api/crypto/payments", {
      amount: 10,
      currency: "USDC",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/crypto/status returns status", async () => {
    const response = await api.get("/api/crypto/status");
    expect([200, 401]).toContain(response.status);
  });

  test("GET /api/crypto/payments/[id] returns 404 for nonexistent", async () => {
    const response = await api.get("/api/crypto/payments/nonexistent-id", {
      authenticated: true,
    });
    expect([404, 400, 401]).toContain(response.status);
  });
});

describe("Redemptions API", () => {
  test("GET /api/v1/redemptions requires auth", async () => {
    const response = await api.get("/api/v1/redemptions");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/redemptions returns list", async () => {
    const response = await api.get("/api/v1/redemptions", {
      authenticated: true,
    });
    expect(response.status).toBe(200);
  });
});

describe("x402 API", () => {
  test("GET /api/v1/x402 responds", async () => {
    const response = await api.get("/api/v1/x402");
    expect([200, 401, 403, 503]).toContain(response.status);
  });
});
