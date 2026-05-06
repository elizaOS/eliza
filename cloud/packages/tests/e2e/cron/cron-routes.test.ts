import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";

/**
 * Cron Route E2E Tests
 *
 * Validates cron endpoint auth behavior:
 * - protected routes fail closed when auth/config is missing
 * - public health-check GET routes stay readable without auth
 * - protected routes accept a valid CRON_SECRET
 */

const CRON_ROUTES = [
  "/api/cron/agent-budgets",
  "/api/cron/auto-top-up",
  "/api/cron/cleanup-anonymous-sessions",
  "/api/cron/cleanup-cli-sessions",
  "/api/cron/cleanup-expired-crypto-payments",
  "/api/cron/cleanup-priorities",
  "/api/cron/cleanup-webhook-events",
  "/api/cron/compute-metrics",
  "/api/cron/container-billing",
  "/api/cron/process-redemptions",
  "/api/cron/release-pending-earnings",
  "/api/cron/sample-eliza-price",
  "/api/cron/social-automation",
] as const;

const V1_CRON_ROUTES = [
  "/api/v1/cron/health-check",
  "/api/v1/cron/deployment-monitor",
  "/api/v1/cron/process-provisioning-jobs",
  "/api/v1/cron/refresh-model-catalog",
  "/api/v1/cron/refresh-pricing",
] as const;

const ALL_CRON_ROUTES = [...CRON_ROUTES, ...V1_CRON_ROUTES] as const;
const PUBLIC_HEALTH_ROUTES = new Set<string>([
  "/api/cron/process-redemptions",
  "/api/cron/sample-eliza-price",
]);

function expectedUnauthStatuses(route: string): number[] {
  if (PUBLIC_HEALTH_ROUTES.has(route)) {
    return [200];
  }

  return [401, 403, 503];
}

function expectedWrongSecretStatuses(route: string): number[] {
  if (PUBLIC_HEALTH_ROUTES.has(route)) {
    return [200];
  }

  return [401, 403, 503];
}

describe("Cron Routes", () => {
  describe("Unauthenticated — rejects requests without auth", () => {
    for (const route of ALL_CRON_ROUTES) {
      test(`GET ${route} rejects unauthenticated request`, async () => {
        const response = await api.get(route);
        expect(expectedUnauthStatuses(route)).toContain(response.status);
      });
    }
  });

  describe("Wrong Secret — rejects requests with invalid secret", () => {
    for (const route of ALL_CRON_ROUTES) {
      test(`GET ${route} rejects wrong CRON_SECRET`, async () => {
        const response = await api.get(route, {
          headers: { Authorization: "Bearer wrong-secret-value" },
        });
        expect(expectedWrongSecretStatuses(route)).toContain(response.status);
      });
    }
  });

  describe("With CRON_SECRET", () => {
    test("cron routes accept valid CRON_SECRET", async () => {
      // Test just one route with CRON_SECRET to verify auth works
      const response = await api.get(ALL_CRON_ROUTES[0], {
        headers: api.cronHeaders(),
      });
      expect(response.status).toBe(200);
    });

    test("v1 cron routes accept valid CRON_SECRET", async () => {
      const response = await api.get(V1_CRON_ROUTES[0], {
        headers: api.cronHeaders(),
      });
      expect(response.status).toBe(200);
    });
  });
});
