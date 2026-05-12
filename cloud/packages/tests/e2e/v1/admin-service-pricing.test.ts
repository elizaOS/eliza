import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";

/**
 * Admin service-pricing E2E smoke.
 *
 * This intentionally exercises the real HTTP route and auth stack instead of
 * mocking route dependencies. The write-path check uses an invalid payload so
 * it can validate admin auth and request validation without mutating pricing
 * state in a shared environment.
 */

describe("Admin Service Pricing API", () => {
  test("GET /api/v1/admin/service-pricing requires admin auth", async () => {
    const response = await api.get("/api/v1/admin/service-pricing?service_id=solana-rpc");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/admin/service-pricing returns data for an admin key or 403 for a non-admin key", async () => {
    const response = await api.get("/api/v1/admin/service-pricing?service_id=solana-rpc", {
      authenticated: true,
    });
    expect([200, 403]).toContain(response.status);

    if (response.status === 200) {
      const body = (await response.json()) as {
        pricing?: unknown[];
        service_id?: string;
      };
      expect(body.service_id).toBe("solana-rpc");
      expect(Array.isArray(body.pricing)).toBe(true);
    }
  });

  test("GET /api/v1/admin/service-pricing requires service_id even for authenticated admins", async () => {
    const response = await api.get("/api/v1/admin/service-pricing", {
      authenticated: true,
    });
    expect([400, 403]).toContain(response.status);
  });

  test("PUT /api/v1/admin/service-pricing requires admin auth", async () => {
    const response = await api.put("/api/v1/admin/service-pricing", {
      service_id: "solana-rpc",
      method: "getBalance",
      cost: 0.001,
      reason: "test",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("PUT /api/v1/admin/service-pricing rejects invalid payloads over the real route", async () => {
    const response = await api.put(
      "/api/v1/admin/service-pricing",
      {
        service_id: "solana-rpc",
        // Missing method/reason and invalid negative cost.
        cost: -1,
      },
      { authenticated: true },
    );
    expect([400, 403]).toContain(response.status);

    if (response.status === 400) {
      const body = (await response.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
    }
  });
});
