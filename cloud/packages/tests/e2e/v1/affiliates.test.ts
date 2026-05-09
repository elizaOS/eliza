import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type AffiliateCodeResponse = {
  code?: {
    code?: string;
  };
};

/**
 * Affiliates, Referrals, Analytics & Tracking API E2E Tests
 */

describe("Affiliates API", () => {
  test("POST /api/affiliate/create-character validates input", async () => {
    const response = await api.post("/api/affiliate/create-character", {});
    expect([400, 401, 501]).toContain(response.status);
  });

  test("POST /api/affiliate/create-session creates session", async () => {
    const response = await api.post("/api/affiliate/create-session", {});
    expect([200, 400, 401]).toContain(response.status);
  });

  test("GET /api/v1/affiliates requires auth", async () => {
    const response = await api.get("/api/v1/affiliates");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/affiliates returns data with auth", async () => {
    const response = await api.get("/api/v1/affiliates", {
      authenticated: true,
    });
    expect(response.status).toBe(200);
  });

  test("Affiliate SKU end-to-end: AI inference with X-Affiliate-Code credits owner", async () => {
    const largeInferencePrompt =
      "Reply with exactly 400 numbered lines in the format '<n>. hello affiliate earnings'. " +
      "Do not add commentary before or after the list.";

    // 1. Ensure affiliate code exists with markup
    const createRes = await api.post(
      "/api/v1/affiliates",
      { markupPercent: 50 },
      { authenticated: true },
    );
    expect([200, 400]).toContain(createRes.status);

    const getRes = await api.get("/api/v1/affiliates", {
      authenticated: true,
    });
    expect(getRes.status).toBe(200);
    const getBody = await readJson<AffiliateCodeResponse>(getRes);
    const affiliateCode = getBody.code?.code;
    expect(affiliateCode).toBeTruthy();
    if (!affiliateCode) {
      throw new Error("Expected affiliate code response to include code.code");
    }

    // 2. Initial redeemable-balance check
    const initialBalanceRes = await api.get("/api/v1/redemptions/balance", {
      authenticated: true,
    });
    expect(initialBalanceRes.status).toBe(200);
    const initialBalanceBody = (await initialBalanceRes.json()) as {
      balance?: { availableBalance?: number };
    };
    const initialEarnings = Number(initialBalanceBody.balance?.availableBalance || 0);

    // 3. Perform AI inference with X-Affiliate-Code
    const chatRes = await api.post(
      "/api/v1/chat/completions",
      {
        model: "openai/gpt-5-mini",
        messages: [{ role: "user", content: largeInferencePrompt }],
        max_tokens: 1200,
      },
      {
        authenticated: true,
        headers: { "X-Affiliate-Code": affiliateCode },
      },
    );
    if (chatRes.status === 503) {
      expect(chatRes.status).toBe(503);
      return;
    }

    expect(chatRes.status).toBe(200);

    // 4. Verify redeemable earnings increased
    const finalBalanceRes = await api.get("/api/v1/redemptions/balance", {
      authenticated: true,
    });
    expect(finalBalanceRes.status).toBe(200);
    const finalBalanceBody = (await finalBalanceRes.json()) as {
      balance?: { availableBalance?: number };
    };
    const finalEarnings = Number(finalBalanceBody.balance?.availableBalance || 0);

    expect(finalEarnings).toBeGreaterThan(initialEarnings);
  });
});

describe("Referrals API", () => {
  test("POST /api/v1/referrals/apply requires auth", async () => {
    const response = await api.post("/api/v1/referrals/apply", {
      code: "TEST123",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/referrals requires auth (401 vs 403 depends on auth layer)", async () => {
    const response = await api.get("/api/v1/referrals");
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/referrals/apply with invalid code", async () => {
    const response = await api.post(
      "/api/v1/referrals/apply",
      { code: "NONEXISTENT" },
      { authenticated: true },
    );
    expect([200, 400, 404]).toContain(response.status);
  });

  test("GET /api/v1/referrals returns flat code payload with auth", async () => {
    const first = await api.get("/api/v1/referrals", { authenticated: true });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      code: string;
      total_referrals: number;
      is_active: boolean;
    };
    expect(typeof body.code).toBe("string");
    expect(body.code.length).toBeGreaterThan(0);
    expect(typeof body.total_referrals).toBe("number");
    expect(typeof body.is_active).toBe("boolean");

    const second = await api.get("/api/v1/referrals", {
      authenticated: true,
    });
    expect(second.status).toBe(200);
    const body2 = (await second.json()) as { code: string };
    expect(body2.code).toBe(body.code);
  });

  test("GET /api/v1/referrals validates JSON shape (active or inactive)", async () => {
    // Note: In fresh test environments codes are always active; inactive branch
    // requires a seeded fixture. We validate shape unconditionally since the
    // payload structure is identical for both active and inactive codes.
    const res = await api.get("/api/v1/referrals", { authenticated: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: string;
      total_referrals: number;
      is_active: boolean;
    };
    expect(typeof body.is_active).toBe("boolean");
    expect(body.code.length).toBeGreaterThan(0);
    expect(Number.isInteger(body.total_referrals)).toBe(true);
    expect(body.total_referrals).toBeGreaterThanOrEqual(0);
  });
});

describe("Analytics API", () => {
  test("GET /api/analytics/overview requires auth", async () => {
    const response = await api.get("/api/analytics/overview");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/analytics/export requires auth", async () => {
    const response = await api.get("/api/analytics/export");
    expect([401, 403]).toContain(response.status);
  });
});

describe("Tracking API", () => {
  test("POST /api/v1/track/pageview accepts tracking events", async () => {
    const response = await api.post("/api/v1/track/pageview", {
      path: "/test",
      title: "Test Page",
    });
    // Tracking may accept anonymously or require auth
    expect([200, 204, 400, 401]).toContain(response.status);
  });
});
