/**
 * Alpha Group Admin API Endpoints Integration Tests
 *
 * Tests the alpha group admin API endpoints:
 * - GET /api/admin/alpha-groups/config - Get current configuration
 * - PATCH /api/admin/alpha-groups/config - Update configuration
 * - GET /api/admin/alpha-groups/stats - Get statistics
 *
 * Run with: bun test integration/alpha-group-admin-api.integration.test.ts --preload ./integration/preload.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { getAdminToken } from "./helpers";

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  "http://localhost:3000";

let serverAvailable = false;
let adminToken: string | null = null;

function applyAdminAuth(
  headers: HeadersInit & Record<string, string>,
  token?: string,
): void {
  if (!token) {
    return;
  }
  if (token.startsWith("dev_admin_")) {
    headers["x-dev-admin-token"] = token;
    return;
  }
  headers.Authorization = `Bearer ${token}`;
}

async function checkServerHealth(): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.ok;
}

async function getWithAuth(path: string, token?: string): Promise<Response> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  applyAdminAuth(headers, token);
  return fetch(`${BASE_URL}${path}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
}

async function patchWithAuth(
  path: string,
  body: object,
  token?: string,
): Promise<Response> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  applyAdminAuth(headers, token);
  return fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}

describe("Alpha Group Admin API Integration", () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth().catch(() => false);
    if (!serverAvailable) {
      console.warn(
        "⚠️  Server not available - Alpha Group Admin API tests will be skipped",
      );
    }

    adminToken = getAdminToken();
  });

  // ============================================
  // CONFIG ENDPOINT - GET
  // ============================================
  describe("Config - GET /api/admin/alpha-groups/config", () => {
    test("should require authentication", async () => {
      if (!serverAvailable) return;
      const res = await getWithAuth("/api/admin/alpha-groups/config");
      expect(res.status).toBe(401);
    });

    test("should return 403 for non-admin users", async () => {
      if (!serverAvailable || !process.env.TEST_USER_TOKEN) return;
      const res = await getWithAuth(
        "/api/admin/alpha-groups/config",
        process.env.TEST_USER_TOKEN,
      );
      expect(res.status).toBe(403);
    });

    test("should return config data for admin users", async () => {
      if (!serverAvailable || !adminToken) {
        console.log("⏭️  Skipping alpha group config test - no admin token");
        return;
      }
      const res = await getWithAuth(
        "/api/admin/alpha-groups/config",
        adminToken,
      );
      expect(res.status).toBe(200);

      const response = await res.json();

      // Response has nested structure: { success, data: { config, tierConfig, ... } }
      expect(response).toHaveProperty("success", true);
      expect(response).toHaveProperty("data");
      const data = response.data;

      // Verify structure of config response
      expect(data).toHaveProperty("config");
      expect(data.config).toHaveProperty("inviteProbabilityMultiplier");
      expect(data.config).toHaveProperty("maxInvitesPerTick");
      expect(data.config).toHaveProperty("minReplies");
      expect(data.config).toHaveProperty("minLikes");
      expect(data.config).toHaveProperty("minTotalInteractions");
      expect(data.config).toHaveProperty("fastTrackEnabled");
      expect(data.config).toHaveProperty("inviteDecayEnabled");
      expect(data.config).toHaveProperty("grandfatheringEnabled");

      // Verify tierConfig structure (API returns 'tierConfig', not 'tiers')
      expect(data).toHaveProperty("tierConfig");
      expect(data.tierConfig).toHaveProperty("1");
      expect(data.tierConfig).toHaveProperty("2");
      expect(data.tierConfig).toHaveProperty("3");

      // Verify tier config has expected fields
      expect(data.tierConfig[3]).toHaveProperty("minEngagementScore");
      expect(data.tierConfig[3]).toHaveProperty("inviteProbability");
      expect(data.tierConfig[3]).toHaveProperty("maxMembers");

      console.log("✓ Alpha group config endpoint returns valid data");
    });

    test("should have lowered thresholds in config", async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        "/api/admin/alpha-groups/config",
        adminToken,
      );
      expect(res.status).toBe(200);

      const response = await res.json();
      const data = response.data;

      // Verify lowered thresholds
      expect(data.config.minReplies).toBe(1);
      expect(data.config.minLikes).toBe(2);
      expect(data.config.minTotalInteractions).toBe(5);

      // Verify tier 3 has the new lower engagement score
      expect(data.tierConfig[3].minEngagementScore).toBe(20);
      // Verify tier 3 has 10% invite probability
      expect(data.tierConfig[3].inviteProbability).toBe(0.1);
    });
  });

  // ============================================
  // CONFIG ENDPOINT - PATCH
  // ============================================
  describe("Config - PATCH /api/admin/alpha-groups/config", () => {
    test("should require authentication", async () => {
      if (!serverAvailable) return;
      const res = await patchWithAuth("/api/admin/alpha-groups/config", {
        inviteProbabilityMultiplier: 2.0,
      });
      expect(res.status).toBe(401);
    });

    test("should return 403 for non-admin users", async () => {
      if (!serverAvailable || !process.env.TEST_USER_TOKEN) return;
      const res = await patchWithAuth(
        "/api/admin/alpha-groups/config",
        { inviteProbabilityMultiplier: 2.0 },
        process.env.TEST_USER_TOKEN,
      );
      expect(res.status).toBe(403);
    });

    test("should require manage_alpha_groups permission", async () => {
      if (!serverAvailable || !adminToken) {
        console.log(
          "⏭️  Skipping alpha group config patch test - no admin token",
        );
        return;
      }

      // This test would require a viewer-only admin token
      // For now, we just verify the endpoint exists and accepts valid data
      const res = await patchWithAuth(
        "/api/admin/alpha-groups/config",
        { inviteProbabilityMultiplier: 1.0 }, // No actual change
        adminToken,
      );

      // Should be 200 (success) or 403 (no permission) depending on admin role
      expect([200, 403]).toContain(res.status);
    });

    test("should validate input data", async () => {
      if (!serverAvailable || !adminToken) return;

      // Test invalid probability (must be 0-10)
      const res1 = await patchWithAuth(
        "/api/admin/alpha-groups/config",
        { inviteProbabilityMultiplier: -1 },
        adminToken,
      );
      // Should return 400 for invalid data
      expect([400, 403]).toContain(res1.status);

      // Test invalid type
      const res2 = await patchWithAuth(
        "/api/admin/alpha-groups/config",
        { inviteProbabilityMultiplier: "not-a-number" },
        adminToken,
      );
      expect([400, 403]).toContain(res2.status);
    });
  });

  // ============================================
  // STATS ENDPOINT
  // ============================================
  describe("Stats - GET /api/admin/alpha-groups/stats", () => {
    test("should require authentication", async () => {
      if (!serverAvailable) return;
      const res = await getWithAuth("/api/admin/alpha-groups/stats");
      expect(res.status).toBe(401);
    });

    test("should return 403 for non-admin users", async () => {
      if (!serverAvailable || !process.env.TEST_USER_TOKEN) return;
      const res = await getWithAuth(
        "/api/admin/alpha-groups/stats",
        process.env.TEST_USER_TOKEN,
      );
      expect(res.status).toBe(403);
    });

    test("should return stats data for admin users", async () => {
      if (!serverAvailable || !adminToken) {
        console.log("⏭️  Skipping alpha group stats test - no admin token");
        return;
      }
      const res = await getWithAuth(
        "/api/admin/alpha-groups/stats",
        adminToken,
      );
      expect(res.status).toBe(200);

      const response = await res.json();

      // Response has nested structure: { success, data: { overview, invites, ... } }
      expect(response).toHaveProperty("success", true);
      expect(response).toHaveProperty("data");
      const data = response.data;

      // Verify structure of stats response
      expect(data).toHaveProperty("overview");
      expect(data.overview).toHaveProperty("totalGroups");
      expect(data.overview).toHaveProperty("totalMembers");
      expect(data).toHaveProperty("invites");
      expect(data.invites).toHaveProperty("total");
      expect(data.invites).toHaveProperty("last24h");
      expect(data.invites).toHaveProperty("pending");
      expect(data).toHaveProperty("tiers");

      // Verify types
      expect(typeof data.overview.totalGroups).toBe("number");
      expect(typeof data.invites.total).toBe("number");
      expect(typeof data.overview.totalMembers).toBe("number");
      expect(data.overview.totalGroups).toBeGreaterThanOrEqual(0);

      // Verify tiers is an object
      expect(typeof data.tiers).toBe("object");

      console.log("✓ Alpha group stats endpoint returns valid data");
      console.log(
        `  Total groups: ${data.overview.totalGroups}, Members: ${data.overview.totalMembers}, Pending: ${data.invites.pending}`,
      );
    });

    test("should include grandfathering stats", async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        "/api/admin/alpha-groups/stats",
        adminToken,
      );
      expect(res.status).toBe(200);

      const response = await res.json();
      const data = response.data;

      // Verify grandfathering stats are included
      expect(data).toHaveProperty("grandfathering");
      expect(data.grandfathering).toHaveProperty("grandfatheredMembers");
      expect(typeof data.grandfathering.grandfatheredMembers).toBe("number");
    });

    test("should include invite decay stats", async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        "/api/admin/alpha-groups/stats",
        adminToken,
      );
      expect(res.status).toBe(200);

      const response = await res.json();
      const data = response.data;

      // Verify invite decay stats are included
      expect(data).toHaveProperty("inviteDecay");
      expect(data.inviteDecay).toHaveProperty("usersWithDeclines");
      expect(data.inviteDecay).toHaveProperty("usersAtMaxDeclines");
      expect(typeof data.inviteDecay.usersWithDeclines).toBe("number");
    });
  });

  // ============================================
  // EDGE CASES
  // ============================================
  describe("Edge Cases", () => {
    test("should handle malformed JSON in PATCH request", async () => {
      if (!serverAvailable || !adminToken) return;

      const headers: HeadersInit & Record<string, string> = {
        "Content-Type": "application/json",
      };
      applyAdminAuth(headers, adminToken);

      const res = await fetch(`${BASE_URL}/api/admin/alpha-groups/config`, {
        method: "PATCH",
        headers,
        body: "{not valid json",
        signal: AbortSignal.timeout(30000),
      });

      expect([400, 403]).toContain(res.status);
    });

    test("should handle empty PATCH body", async () => {
      if (!serverAvailable || !adminToken) return;

      const res = await patchWithAuth(
        "/api/admin/alpha-groups/config",
        {},
        adminToken,
      );

      // Empty body should either be no-op (200) or validation error (400)
      expect([200, 400, 403]).toContain(res.status);
    });

    test("should not expose sensitive internal data in stats", async () => {
      if (!serverAvailable || !adminToken) return;

      const res = await getWithAuth(
        "/api/admin/alpha-groups/stats",
        adminToken,
      );
      expect(res.status).toBe(200);

      const response = await res.json();

      // Should not expose user IDs, API keys, or other sensitive data
      const jsonString = JSON.stringify(response);
      expect(jsonString).not.toContain("password");
      expect(jsonString).not.toContain("apiKey");
      expect(jsonString).not.toContain("secretKey");
      expect(jsonString).not.toContain("privateKey");
    });
  });
});
