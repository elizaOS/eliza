// Admin Dashboard RBAC Integration Tests
// Run: bun test integration/admin-dashboard-rbac.integration.test.ts --preload ./integration/preload.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getAllAdmins } from "@feed/api";
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  adminRoles,
  db,
  eq,
  ROLE_PERMISSIONS,
  users,
} from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";
import {
  getAdminToken,
  requireAuth as requireAuthShared,
  requireServer as requireServerShared,
  waitForServerAvailability,
} from "./helpers";

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  "http://localhost:3000";

let serverAvailable = false;
let devAdminToken: string | null = null;
let skippedTestCount = 0;

const testUserIds: string[] = [];

function requireServer(): void {
  try {
    requireServerShared(serverAvailable, BASE_URL);
  } catch (e) {
    skippedTestCount++;
    throw e;
  }
}

function requireAuth(): void {
  try {
    requireAuthShared(serverAvailable, devAdminToken, BASE_URL);
  } catch (e) {
    skippedTestCount++;
    throw e;
  }
}

async function adminRequest(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (devAdminToken) headers["x-dev-admin-token"] = devAdminToken;

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15000),
  });
}

async function publicRequest(path: string, options: RequestInit = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
    signal: AbortSignal.timeout(15000),
  });
}

async function createTestUser(
  overrides: Partial<{
    username: string;
    isAdmin: boolean;
    isAgent: boolean;
    isActor: boolean;
    isBanned: boolean;
  }> = {},
) {
  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: overrides.username || `rbac-test-${userId}`,
    displayName: `Test User ${userId}`,
    isAdmin: overrides.isAdmin || false,
    isAgent: overrides.isAgent || false,
    isActor: overrides.isActor || false,
    isBanned: overrides.isBanned || false,
    updatedAt: new Date(),
  });
  testUserIds.push(userId);
  return userId;
}

async function createAdminRole(
  userId: string,
  role: "SUPER_ADMIN" | "ADMIN" | "VIEWER",
  grantedBy: string,
) {
  const roleId = `admin_role_${await generateSnowflakeId()}`;
  await db.insert(adminRoles).values({
    id: roleId,
    userId,
    role,
    permissions: ROLE_PERMISSIONS[role],
    grantedBy,
    grantedAt: new Date(),
  });
  return roleId;
}

describe("Admin Dashboard RBAC Integration Tests", () => {
  beforeAll(async () => {
    // Check if server is running
    try {
      if (await waitForServerAvailability(BASE_URL, 10, 5000)) {
        serverAvailable = true;
        console.log("✅ Server available for testing");
      }
    } catch {
      console.warn("⚠️  Server not available - API tests will be skipped");
    }

    // Get admin token (CI_ADMIN_TOKEN in CI, dev credentials locally)
    devAdminToken = getAdminToken();
    if (devAdminToken) {
      console.log("✅ Admin token available");
    } else {
      console.warn("⚠️  Admin token not available - auth tests limited");
    }
  });

  afterAll(async () => {
    // Clean up test admin roles
    for (const userId of testUserIds) {
      await db.delete(adminRoles).where(eq(adminRoles.userId, userId));
    }

    // Clean up test users
    for (const userId of testUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }

    console.log(`✅ Cleaned up ${testUserIds.length} test users`);
    if (skippedTestCount > 0) {
      console.warn(
        `⚠️  ${skippedTestCount} tests were skipped due to missing server/auth`,
      );
    }
  });

  describe("RBAC Constants", () => {
    test("ADMIN_ROLES contains expected roles", () => {
      expect(ADMIN_ROLES).toContain("SUPER_ADMIN");
      expect(ADMIN_ROLES).toContain("ADMIN");
      expect(ADMIN_ROLES).toContain("VIEWER");
      expect(ADMIN_ROLES).toHaveLength(3);
    });

    test("ADMIN_PERMISSIONS contains all expected permissions", () => {
      const expectedPermissions: readonly string[] = [
        "view_stats",
        "view_users",
        "manage_users",
        "view_trading",
        "view_system",
        "give_feedback",
        "manage_admins",
        "manage_game",
        "view_reports",
        "resolve_reports",
        "manage_escrow",
      ];

      for (const perm of expectedPermissions) {
        expect(ADMIN_PERMISSIONS as readonly string[]).toContain(perm);
      }
    });

    test("ROLE_PERMISSIONS assigns correct permissions to SUPER_ADMIN", () => {
      // SUPER_ADMIN should have all permissions
      expect(ROLE_PERMISSIONS.SUPER_ADMIN).toHaveLength(
        ADMIN_PERMISSIONS.length,
      );
      for (const perm of ADMIN_PERMISSIONS) {
        expect(ROLE_PERMISSIONS.SUPER_ADMIN).toContain(perm);
      }
    });

    test("ROLE_PERMISSIONS assigns correct permissions to ADMIN", () => {
      // ADMIN should not have super-admin-only permissions
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain("manage_admins");
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain("manage_game");
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain("manage_escrow");
      expect(ROLE_PERMISSIONS.ADMIN).toContain("view_stats");
      expect(ROLE_PERMISSIONS.ADMIN).toContain("manage_users");
      expect(ROLE_PERMISSIONS.ADMIN).toContain("resolve_reports");
    });

    test("ROLE_PERMISSIONS assigns correct permissions to VIEWER", () => {
      // VIEWER should only have view permissions
      expect(ROLE_PERMISSIONS.VIEWER).toContain("view_stats");
      expect(ROLE_PERMISSIONS.VIEWER).toContain("view_users");
      expect(ROLE_PERMISSIONS.VIEWER).toContain("view_trading");
      expect(ROLE_PERMISSIONS.VIEWER).toContain("view_system");
      expect(ROLE_PERMISSIONS.VIEWER).not.toContain("manage_users");
      expect(ROLE_PERMISSIONS.VIEWER).not.toContain("manage_admins");
    });

    test("VIEWER has fewer permissions than ADMIN", () => {
      expect(ROLE_PERMISSIONS.VIEWER.length).toBeLessThan(
        ROLE_PERMISSIONS.ADMIN.length,
      );
    });

    test("ADMIN has fewer permissions than SUPER_ADMIN", () => {
      expect(ROLE_PERMISSIONS.ADMIN.length).toBeLessThan(
        ROLE_PERMISSIONS.SUPER_ADMIN.length,
      );
    });
  });

  describe("Database RBAC Operations", () => {
    test("can create admin role for user", async () => {
      const userId = await createTestUser({});
      const roleId = await createAdminRole(userId, "ADMIN", userId);

      const [role] = await db
        .select()
        .from(adminRoles)
        .where(eq(adminRoles.id, roleId))
        .limit(1);

      expect(role).toBeDefined();
      expect(role?.userId).toBe(userId);
      expect(role?.role).toBe("ADMIN");
      expect(role?.permissions).toEqual(ROLE_PERMISSIONS.ADMIN);
      expect(role?.revokedAt).toBeNull();
    });

    test("can revoke admin role", async () => {
      const userId = await createTestUser({});
      await createAdminRole(userId, "VIEWER", userId);

      await db
        .update(adminRoles)
        .set({ revokedAt: new Date() })
        .where(eq(adminRoles.userId, userId));

      const [role] = await db
        .select()
        .from(adminRoles)
        .where(eq(adminRoles.userId, userId))
        .limit(1);

      expect(role).toBeDefined();
      expect(role?.revokedAt).not.toBeNull();
    });

    test("legacy isAdmin flag still works", async () => {
      const userId = await createTestUser({ isAdmin: true });

      const [user] = await db
        .select({ isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      expect(user).toBeDefined();
      expect(user?.isAdmin).toBe(true);
    });

    test("legacy isAdmin users are exposed as ADMIN in getAllAdmins", async () => {
      const userId = await createTestUser({ isAdmin: true });
      const admins = await getAllAdmins();
      const legacyAdmin = admins.find((admin) => admin.userId === userId);

      expect(legacyAdmin).toBeDefined();
      expect(legacyAdmin?.role).toBe("ADMIN");
      expect(legacyAdmin?.permissions).toEqual(ROLE_PERMISSIONS.ADMIN);
    });

    test("user can have role without legacy isAdmin", async () => {
      const userId = await createTestUser({ isAdmin: false });
      await createAdminRole(userId, "SUPER_ADMIN", userId);

      const [user] = await db
        .select({ isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const [role] = await db
        .select()
        .from(adminRoles)
        .where(eq(adminRoles.userId, userId))
        .limit(1);

      expect(user).toBeDefined();
      expect(role).toBeDefined();
      expect(user?.isAdmin).toBe(false);
      expect(role?.role).toBe("SUPER_ADMIN");
    });

    test("handles non-existent user gracefully", async () => {
      const [role] = await db
        .select()
        .from(adminRoles)
        .where(eq(adminRoles.userId, "non-existent-user-id"))
        .limit(1);
      expect(role).toBeUndefined();
    });
  });

  describe("Admin Stats API - Users", () => {
    test("GET /api/admin/stats/users - requires auth", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/stats/users");
      expect(res.status).toBe(401);
    });

    test("GET /api/admin/stats/users - returns user statistics", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/users");
      expect(res.status).toBe(200);

      const stats = await res.json();
      expect(stats).toBeDefined();

      // Verify structure
      expect(stats.overview).toBeDefined();
      expect(typeof stats.overview.total).toBe("number");
      expect(typeof stats.overview.realUsers).toBe("number");
      expect(typeof stats.overview.actors).toBe("number");
      expect(typeof stats.overview.agents).toBe("number");
      expect(typeof stats.overview.banned).toBe("number");

      expect(stats.signups).toBeDefined();
      expect(typeof stats.signups.today).toBe("number");
      expect(typeof stats.signups.thisWeek).toBe("number");

      expect(stats.profileMetrics).toBeDefined();
      expect(stats.socialConnections).toBeDefined();
      expect(Array.isArray(stats.topReferrers)).toBe(true);
      expect(Array.isArray(stats.recentSignups)).toBe(true);
    });

    test("GET /api/admin/stats/users - with time series", async () => {
      requireAuth();

      const res = await adminRequest(
        "/api/admin/stats/users?includeTimeSeries=true",
      );
      expect(res.status).toBe(200);

      const stats = await res.json();
      expect(Array.isArray(stats.timeSeries)).toBe(true);

      if (stats.timeSeries.length > 0) {
        const entry = stats.timeSeries[0];
        expect(entry.date).toBeDefined();
        expect(typeof entry.signups).toBe("number");
        expect(typeof entry.cumulative).toBe("number");
      }
    });

    test("GET /api/admin/stats/users - with date filter", async () => {
      requireAuth();

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      const endDate = new Date();

      const res = await adminRequest(
        `/api/admin/stats/users?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
      );
      expect(res.status).toBe(200);

      const stats = await res.json();
      expect(stats.filters.startDate).toBeDefined();
      expect(stats.filters.endDate).toBeDefined();
    });

    test("GET /api/admin/stats/users - with invalid date gracefully handles", async () => {
      requireAuth();

      const res = await adminRequest(
        "/api/admin/stats/users?startDate=invalid-date&endDate=also-invalid",
      );
      expect(res.status).toBe(200);

      const stats = await res.json();
      // Invalid dates should be parsed as null
      expect(stats.filters.startDate).toBeNull();
      expect(stats.filters.endDate).toBeNull();
    });

    test("GET /api/admin/stats/users - verifies counts are non-negative", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/users");
      const stats = await res.json();

      expect(stats.overview.total).toBeGreaterThanOrEqual(0);
      expect(stats.overview.realUsers).toBeGreaterThanOrEqual(0);
      expect(stats.signups.today).toBeGreaterThanOrEqual(0);
      expect(stats.profileMetrics.profileCompletionRate).toBeGreaterThanOrEqual(
        0,
      );
      expect(stats.profileMetrics.profileCompletionRate).toBeLessThanOrEqual(
        100,
      );
    });
  });

  describe("Admin Stats API - Trading", () => {
    test("GET /api/admin/stats/trading - requires auth", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/stats/trading");
      expect(res.status).toBe(401);
    });

    test("GET /api/admin/stats/trading - returns trading statistics", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/trading");
      expect(res.status).toBe(200);

      const stats = await res.json();

      expect(stats.overview).toBeDefined();
      expect(typeof stats.overview.totalMarkets).toBe("number");
      expect(typeof stats.overview.activeMarkets).toBe("number");
      expect(typeof stats.overview.totalPositions).toBe("number");

      expect(stats.volume).toBeDefined();
      expect(typeof stats.volume.totalBalanceTransactions).toBe("number");

      expect(stats.fees).toBeDefined();
      expect(typeof stats.fees.totalFees).toBe("number");
      expect(typeof stats.fees.feeRate).toBe("number");

      expect(Array.isArray(stats.topTraders)).toBe(true);
      expect(Array.isArray(stats.topMarkets)).toBe(true);
      expect(Array.isArray(stats.recentTrades)).toBe(true);
    });

    test("GET /api/admin/stats/trading - with time series", async () => {
      requireAuth();

      const res = await adminRequest(
        "/api/admin/stats/trading?includeTimeSeries=true",
      );
      expect(res.status).toBe(200);

      const stats = await res.json();
      expect(Array.isArray(stats.timeSeries)).toBe(true);
    });

    test("GET /api/admin/stats/trading - topTraders have correct structure", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/trading");
      const stats = await res.json();

      expect(Array.isArray(stats.topTraders)).toBe(true);
      if (stats.topTraders.length > 0) {
        const trader = stats.topTraders[0];
        expect(trader.userId).toBeDefined();
        expect(typeof trader.tradeCount).toBe("number");
        expect(typeof trader.totalVolume).toBe("number");
      }
    });

    test("GET /api/admin/stats/trading - verifies market counts consistency", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/trading");
      const stats = await res.json();

      const { totalMarkets, activeMarkets, resolvedMarkets } = stats.overview;
      expect(activeMarkets + resolvedMarkets).toBeLessThanOrEqual(
        totalMarkets + 1,
      );
    });
  });

  describe("Admin Stats API - System", () => {
    test("GET /api/admin/stats/system - requires auth", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/stats/system");
      expect(res.status).toBe(401);
    });

    test("GET /api/admin/stats/system - returns system health", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/system");
      expect(res.status).toBe(200);

      const stats = await res.json();

      expect(stats.health).toBeDefined();
      expect(typeof stats.health.database).toBe("boolean");
      expect(typeof stats.health.redis).toBe("boolean");
      expect(typeof stats.health.overall).toBe("boolean");
      expect(stats.health.timestamp).toBeDefined();

      expect(stats.llm).toBeDefined();
      expect(typeof stats.llm.callsLast24h).toBe("number");
      expect(typeof stats.llm.errorsLastHour).toBe("number");

      expect(stats.content).toBeDefined();
      expect(typeof stats.content.lookaheadMinutes).toBe("number");
      expect(typeof stats.content.isHealthy).toBe("boolean");

      expect(stats.realtime).toBeDefined();
      expect(typeof stats.realtime.outboxPending).toBe("number");
      expect(typeof stats.realtime.isHealthy).toBe("boolean");

      expect(stats.environment).toBeDefined();
    });

    test("GET /api/admin/stats/system - includes subsystem summary for observability UI", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/system");
      const stats = await res.json();

      expect(["healthy", "warning", "critical"]).toContain(stats.status);
      expect(stats.summary).toBeDefined();
      expect(typeof stats.summary.total).toBe("number");
      expect(Array.isArray(stats.subsystems)).toBe(true);
      expect(stats.subsystems.length).toBeGreaterThan(0);

      const subsystem = stats.subsystems[0];
      expect(typeof subsystem.key).toBe("string");
      expect(typeof subsystem.label).toBe("string");
      expect(["healthy", "warning", "critical"]).toContain(subsystem.status);
      expect(typeof subsystem.summary).toBe("string");
      expect(typeof subsystem.details).toBe("string");

      expect(stats.performance).toBeDefined();
      expect(typeof stats.performance.query.slowRate).toBe("number");
      expect(typeof stats.performance.memory.usagePercent).toBe("number");
    });

    test("GET /api/admin/stats/system - database tables have valid structure", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/system");
      const stats = await res.json();

      expect(Array.isArray(stats.database.tables)).toBe(true);
      expect(stats.database.tables.length).toBeGreaterThan(0);

      const table = stats.database.tables[0];
      expect(typeof table.name).toBe("string");
      expect(typeof table.rowCount).toBe("number");
      expect(typeof table.sizeBytes).toBe("number");
      expect(typeof table.sizeMB).toBe("number");
      expect(table.rowCount).toBeGreaterThanOrEqual(0);
      expect(table.sizeBytes).toBeGreaterThanOrEqual(0);
    });

    test("GET /api/admin/stats/system - cron jobs info present", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/system");
      const stats = await res.json();

      expect(stats.cronJobs).toBeDefined();
      expect(Array.isArray(stats.cronJobs.allJobs)).toBe(true);
    });

    test("GET /api/admin/stats/system - locks array valid", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/system");
      const stats = await res.json();

      expect(stats.locks).toBeDefined();
      expect(Array.isArray(stats.locks.active)).toBe(true);
      if (stats.locks.active.length > 0) {
        const lock = stats.locks.active[0];
        expect(lock.id).toBeDefined();
        expect(lock.lockType).toBeDefined();
        expect(lock.acquiredAt).toBeDefined();
        expect(typeof lock.ageSeconds).toBe("number");
      }
    });
  });

  describe("Admin Roles API", () => {
    test("GET /api/admin/roles - requires auth", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/roles");
      expect(res.status).toBe(401);
    });

    test("GET /api/admin/roles - returns admin list", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/roles");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data.admins)).toBe(true);
    });

    test("POST /api/admin/roles - requires super admin", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({
          action: "grant",
          userId: "fake-id",
          role: "VIEWER",
        }),
      });
      expect(res.status).toBe(401);
    });

    test("POST /api/admin/roles - validates required fields", async () => {
      requireAuth();

      const res1 = await adminRequest("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res1.status).toBe(400);

      const res2 = await adminRequest("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({ action: "grant", role: "VIEWER" }),
      });
      expect(res2.status).toBe(400);
    });

    test("POST /api/admin/roles - rejects invalid role", async () => {
      requireAuth();

      const userId = await createTestUser({});

      const res = await adminRequest("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({
          action: "grant",
          userId,
          role: "INVALID_ROLE",
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toBe("Invalid input");
    });

    test("POST /api/admin/roles - rejects invalid action", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({
          action: "invalid_action",
          userId: "fake-user",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("POST /api/admin/roles - handles non-existent user", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({
          action: "grant",
          userId: "definitely-not-a-real-user-id",
          role: "VIEWER",
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Admin Permissions API", () => {
    test("GET /api/admin/permissions - requires auth", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/permissions");
      expect(res.status).toBe(401);
    });

    test("GET /api/admin/permissions - returns user permissions", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/permissions");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.role).toBeDefined();
      expect(Array.isArray(data.permissions)).toBe(true);
    });

    test("GET /api/admin/permissions - dev token gets SUPER_ADMIN", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/permissions");
      const data = await res.json();

      expect(data.role).toBe("SUPER_ADMIN");
      expect(data.permissions).toEqual(
        expect.arrayContaining(["manage_admins", "view_stats", "manage_users"]),
      );
    });
  });

  describe("Admin Environment API", () => {
    test("GET /api/admin/environment - requires auth", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/environment");
      expect(res.status).toBe(401);
    });

    test("GET /api/admin/environment - returns current environment", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/environment");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(["development", "staging", "production"]).toContain(data.actual);
    });

    test("POST /api/admin/environment - validates environment value", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/environment", {
        method: "POST",
        body: JSON.stringify({ environment: "invalid-env" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Error Handling", () => {
    test("invalid JSON body returns 400", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/roles", {
        method: "POST",
        body: "not valid json {{{",
      });
      expect(res.status).toBe(400);
    });

    test("error responses do not expose stack traces", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/roles", {
        method: "POST",
        body: JSON.stringify({
          action: "grant",
          userId: "invalid",
          role: "INVALID",
        }),
      });

      const text = await res.text();
      expect(text.toLowerCase()).not.toContain("stack");
      expect(text.toLowerCase()).not.toContain("node_modules");
    });

    test("unauthorized error format is consistent", async () => {
      requireServer();

      const endpoints = [
        "/api/admin/stats/users",
        "/api/admin/stats/trading",
        "/api/admin/stats/system",
        "/api/admin/roles",
        "/api/admin/permissions",
      ];

      for (const endpoint of endpoints) {
        const res = await publicRequest(endpoint);
        expect(res.status).toBe(401);

        const data = await res.json();
        expect(data.error).toBeDefined();
      }
    });
  });

  describe("Edge Cases", () => {
    test("handles empty time series gracefully", async () => {
      requireAuth();

      // Request very old date range that likely has no data
      const oldDate = new Date("2000-01-01");
      const res = await adminRequest(
        `/api/admin/stats/users?startDate=${oldDate.toISOString()}&endDate=${oldDate.toISOString()}&includeTimeSeries=true`,
      );

      expect(res.status).toBe(200);
      const stats = await res.json();
      expect(Array.isArray(stats.timeSeries)).toBe(true);
    });

    test("handles concurrent requests", async () => {
      requireAuth();

      // Fire 5 concurrent requests
      const requests = [
        adminRequest("/api/admin/stats/users"),
        adminRequest("/api/admin/stats/trading"),
        adminRequest("/api/admin/stats/system"),
        adminRequest("/api/admin/roles"),
        adminRequest("/api/admin/permissions"),
      ];

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    });

    test("SQL injection in query params handled safely", async () => {
      requireAuth();

      const res = await adminRequest(
        "/api/admin/stats/users?userType='; DROP TABLE users; --",
      );

      expect(res.status).toBe(200);
    });

    test("very long query params handled gracefully", async () => {
      requireAuth();

      const longValue = "a".repeat(10000);
      const res = await adminRequest(
        `/api/admin/stats/users?userType=${longValue}`,
      );

      expect(res.status).toBe(200);
    });
  });

  describe("Data Integrity", () => {
    test("user stats counts are consistent", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/users");
      const stats = await res.json();

      const { total, realUsers, actors, agents } = stats.overview;
      expect(total).toBeGreaterThanOrEqual(Math.max(realUsers, actors, agents));
    });

    test("trading stats fees are non-negative", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/trading");
      const stats = await res.json();

      expect(stats.fees.totalFees).toBeGreaterThanOrEqual(0);
      expect(stats.fees.platformFees).toBeGreaterThanOrEqual(0);
      expect(stats.fees.referrerFees).toBeGreaterThanOrEqual(0);
    });

    test("system health timestamp is recent", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/system");
      const stats = await res.json();

      const timestamp = new Date(stats.health.timestamp);
      const diffSeconds = Math.abs(Date.now() - timestamp.getTime()) / 1000;
      expect(diffSeconds).toBeLessThan(60);
    });

    test("admin list contains valid role values", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/roles");
      const data = await res.json();

      for (const admin of data.admins) {
        expect(ADMIN_ROLES).toContain(admin.role);
        expect(Array.isArray(admin.permissions)).toBe(true);
      }
    });
  });
});
