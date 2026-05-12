import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type RedemptionStatusResponse = {
  success: boolean;
  canRedeem: boolean;
  availableNetworks: unknown[];
};

type RedemptionBalanceResponse = {
  success: boolean;
  balance: unknown;
  eligibility: unknown;
  recentEarnings: unknown[];
};

type RedemptionValidationResponse = {
  success: boolean;
};

/**
 * Token Redemptions API E2E Tests
 */
setDefaultTimeout(15_000);

describe("Redemptions API", () => {
  describe("GET /api/v1/redemptions/status", () => {
    test("returns system status with auth", async () => {
      const response = await api.get("/api/v1/redemptions/status", {
        authenticated: true,
      });
      expect(response.status).toBe(200);
      const body = await readJson<RedemptionStatusResponse>(response);
      expect(body.success).toBe(true);
      expect(typeof body.canRedeem).toBe("boolean");
      expect(Array.isArray(body.availableNetworks)).toBe(true);
    });
  });

  describe("GET /api/v1/redemptions/balance", () => {
    test("requires auth", async () => {
      const response = await api.get("/api/v1/redemptions/balance");
      expect([401, 403]).toContain(response.status);
    });

    test("returns balance data when authenticated", async () => {
      const response = await api.get("/api/v1/redemptions/balance", {
        authenticated: true,
      });
      expect(response.status).toBe(200);
      const body = await readJson<RedemptionBalanceResponse>(response);
      expect(body.success).toBe(true);
      expect(body.balance).toBeDefined();
      expect(body.eligibility).toBeDefined();
      expect(Array.isArray(body.recentEarnings)).toBe(true);
    });
  });

  describe("GET /api/v1/redemptions/quote", () => {
    test("requires auth", async () => {
      const response = await api.get("/api/v1/redemptions/quote?network=base&pointsAmount=100");
      expect([401, 403]).toContain(response.status);
    });

    test("validates network parameter", async () => {
      const response = await api.get(
        "/api/v1/redemptions/quote?network=invalid_network&pointsAmount=100",
        { authenticated: true },
      );
      expect(response.status).toBe(400);
      const body = await readJson<RedemptionValidationResponse>(response);
      expect(body.success).toBe(false);
    });

    test("gets quote for valid network", async () => {
      const response = await api.get("/api/v1/redemptions/quote?network=base&pointsAmount=100", {
        authenticated: true,
      });
      // Might be 503 if system is down/no balance, which is an expected handled state
      expect([200, 503, 400]).toContain(response.status);
    });
  });

  describe("POST /api/v1/redemptions", () => {
    test("requires auth", async () => {
      const response = await api.post("/api/v1/redemptions", {
        pointsAmount: 100,
        network: "base",
        payoutAddress: "0x1234567890123456789012345678901234567890",
      });
      expect([401, 403]).toContain(response.status);
    });

    test("rejects invalid payload", async () => {
      const response = await api.post(
        "/api/v1/redemptions",
        {
          pointsAmount: 10, // Under minimum
          network: "base",
          payoutAddress: "0x123", // Invalid address
        },
        { authenticated: true },
      );
      expect(response.status).toBe(400);
    });
  });
});
