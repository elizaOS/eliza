import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type CreditsBalanceResponse = {
  balance?: number;
  creditBalance?: number;
};

type CreditTransactionsResponse = { transactions?: unknown[] } | unknown[];

/**
 * Credits API E2E Tests
 */

describe("Credits API", () => {
  test("GET /api/credits/balance requires authentication", async () => {
    const response = await api.get("/api/credits/balance");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/credits/balance returns balance with API key", async () => {
    const response = await api.get("/api/credits/balance", {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<CreditsBalanceResponse>(response);
    expect(body.balance !== undefined || body.creditBalance !== undefined).toBe(true);
  });

  test("GET /api/credits/transactions requires authentication", async () => {
    const response = await api.get("/api/credits/transactions");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/credits/transactions returns transaction list", async () => {
    const response = await api.get("/api/credits/transactions", {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<CreditTransactionsResponse>(response);
    const transactions = Array.isArray(body) ? body : (body.transactions ?? []);
    expect(Array.isArray(transactions)).toBe(true);
  });
});
