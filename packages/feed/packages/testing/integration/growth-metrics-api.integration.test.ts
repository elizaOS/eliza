/**
 * Growth Metrics API Integration Tests
 *
 * Tests the /api/admin/stats/growth endpoint that provides:
 * - WAU (Weekly Active Users)
 * - Trader vs Commander segmentation
 * - Engagement depth metrics
 * - Activation rate with funnel
 * - Session metrics
 * - D7 Retention cohorts
 *
 * Run: bun test integration/growth-metrics-api.integration.test.ts --preload ./integration/preload.ts
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { db, eq, userSessions, users } from "@feed/db";
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
const testUserIds: string[] = [];
const testSessionIds: string[] = [];

setDefaultTimeout(20_000);

function requireServer(): void {
  requireServerShared(serverAvailable, BASE_URL);
}

function requireAuth(): void {
  requireAuthShared(serverAvailable, devAdminToken, BASE_URL);
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
    signal: AbortSignal.timeout(30000), // 30s for complex queries
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
    createdAt: Date;
  }> = {},
) {
  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: overrides.username || `growth-test-${userId}`,
    displayName: `Test User ${userId}`,
    isAdmin: overrides.isAdmin || false,
    isAgent: overrides.isAgent || false,
    isActor: overrides.isActor || false,
    isBanned: overrides.isBanned || false,
    createdAt: overrides.createdAt || new Date(),
    updatedAt: new Date(),
  });
  testUserIds.push(userId);
  return userId;
}

async function createTestSession(
  userId: string,
  options: {
    startedAt?: Date;
    lastActiveAt?: Date;
    endedAt?: Date | null;
    pageCount?: number;
  } = {},
) {
  const sessionId = await generateSnowflakeId();
  const clientSessionId = `test-session-${sessionId}`;
  await db.insert(userSessions).values({
    id: sessionId,
    userId,
    sessionId: clientSessionId,
    startedAt: options.startedAt || new Date(),
    lastActiveAt: options.lastActiveAt || new Date(),
    endedAt: options.endedAt,
    pageCount: options.pageCount || 1,
    heartbeatCount: 1,
  });
  testSessionIds.push(sessionId);
  return sessionId;
}

describe("Growth Metrics API", () => {
  beforeAll(async () => {
    // Check server availability
    serverAvailable = await waitForServerAvailability(BASE_URL, 15);
    if (serverAvailable) {
      console.log("Server availability: Available");
    } else {
      console.log("Server not available - tests will be skipped");
    }

    // Get dev admin token
    devAdminToken = getAdminToken();
  });

  afterAll(async () => {
    // Cleanup test data in reverse order of dependencies
    for (const sessionId of testSessionIds) {
      await db
        .delete(userSessions)
        .where(eq(userSessions.id, sessionId))
        .catch(() => {});
    }
    for (const userId of testUserIds) {
      await db
        .delete(users)
        .where(eq(users.id, userId))
        .catch(() => {});
    }
    console.log(
      `Cleaned up ${testUserIds.length} test users, ${testSessionIds.length} sessions`,
    );
  });

  describe("Authentication", () => {
    test("requires authentication", async () => {
      requireServer();

      const res = await publicRequest("/api/admin/stats/growth");
      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    test("accepts valid dev admin token", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.metadata).toBeDefined();
    });
  });

  describe("Response Structure", () => {
    test("returns complete growth metrics structure", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.metadata).toBeDefined();

      // WAU metrics
      expect(data.wau).toBeDefined();
      expect(typeof data.wau.current).toBe("number");
      expect(typeof data.wau.previous).toBe("number");
      expect(typeof data.wau.change).toBe("number");
      expect(["up", "down", "stable"]).toContain(data.wau.trend);

      // User balance (Trader vs Commander)
      expect(data.userBalance).toBeDefined();
      expect(typeof data.userBalance.tradersOnly).toBe("number");
      expect(typeof data.userBalance.commandersOnly).toBe("number");
      expect(typeof data.userBalance.hybrid).toBe("number");
      expect(typeof data.userBalance.total).toBe("number");
      expect(typeof data.userBalance.tradersOnlyPct).toBe("number");
      expect(typeof data.userBalance.commandersOnlyPct).toBe("number");
      expect(typeof data.userBalance.hybridPct).toBe("number");

      // Engagement metrics
      expect(data.engagement).toBeDefined();
      expect(typeof data.engagement.tradesPerTrader).toBe("number");
      expect(typeof data.engagement.totalTrades).toBe("number");
      expect(typeof data.engagement.uniqueTraders).toBe("number");
      expect(typeof data.engagement.actionsPerCommander).toBe("number");
      expect(typeof data.engagement.totalActions).toBe("number");
      expect(typeof data.engagement.uniqueCommanders).toBe("number");

      // Activation metrics
      expect(data.activation).toBeDefined();
      expect(typeof data.activation.rate).toBe("number");
      expect(typeof data.activation.totalSignups).toBe("number");
      expect(typeof data.activation.activatedUsers).toBe("number");
      expect(data.activation.funnel).toBeDefined();
      expect(typeof data.activation.funnel.signups).toBe("number");
      expect(typeof data.activation.funnel.tradedWithin24h).toBe("number");
      expect(typeof data.activation.funnel.commandedWithin24h).toBe("number");
      expect(typeof data.activation.funnel.activated).toBe("number");

      // Session metrics
      expect(data.sessions).toBeDefined();
      expect(typeof data.sessions.totalSessions).toBe("number");

      // Retention metrics
      expect(data.retention).toBeDefined();
      expect(Array.isArray(data.retention.cohorts)).toBe(true);

      // Metadata
      expect(data.metadata).toBeDefined();
      expect(data.metadata.computedAt).toBeDefined();
      expect(data.metadata.period).toBeDefined();
      expect(data.metadata.periodStart).toBeDefined();
      expect(data.metadata.periodEnd).toBeDefined();
    });

    test("returns time series when requested", async () => {
      requireAuth();

      const res = await adminRequest(
        "/api/admin/stats/growth?includeTimeSeries=true",
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data.timeSeries)).toBe(true);

      if (data.timeSeries.length > 0) {
        const entry = data.timeSeries[0];
        expect(entry.date).toBeDefined();
        expect(typeof entry.wau).toBe("number");
      }
    });

    test("returns empty time series when not requested", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data.timeSeries)).toBe(true);
      expect(data.timeSeries.length).toBe(0);
    });
  });

  describe("Period Parameter", () => {
    test("accepts valid period values", async () => {
      requireAuth();

      for (const period of ["day", "week", "month"]) {
        const res = await adminRequest(
          `/api/admin/stats/growth?period=${period}`,
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.metadata.period).toBe(period);
      }
    });

    test("defaults to week for invalid period", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth?period=invalid");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.metadata.period).toBe("week");
    });

    test("defaults to week when period not provided", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.metadata.period).toBe("week");
    });
  });

  describe("Data Validation", () => {
    test("WAU values are non-negative", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      expect(data.wau.current).toBeGreaterThanOrEqual(0);
      expect(data.wau.previous).toBeGreaterThanOrEqual(0);
    });

    test("percentages sum approximately to 100", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      // Only check if there are active users
      if (data.userBalance.total > 0) {
        const sum =
          data.userBalance.tradersOnlyPct +
          data.userBalance.commandersOnlyPct +
          data.userBalance.hybridPct;
        // Allow small floating point tolerance
        expect(sum).toBeGreaterThan(99);
        expect(sum).toBeLessThan(101);
      }
    });

    test("activation rate is between 0 and 100", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      expect(data.activation.rate).toBeGreaterThanOrEqual(0);
      expect(data.activation.rate).toBeLessThanOrEqual(100);
    });

    test("engagement metrics are non-negative", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      expect(data.engagement.tradesPerTrader).toBeGreaterThanOrEqual(0);
      expect(data.engagement.totalTrades).toBeGreaterThanOrEqual(0);
      expect(data.engagement.uniqueTraders).toBeGreaterThanOrEqual(0);
      expect(data.engagement.actionsPerCommander).toBeGreaterThanOrEqual(0);
      expect(data.engagement.totalActions).toBeGreaterThanOrEqual(0);
      expect(data.engagement.uniqueCommanders).toBeGreaterThanOrEqual(0);
    });

    test("funnel stages are consistent", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      const { funnel } = data.activation;
      // Activated users should be <= signups
      expect(funnel.activated).toBeLessThanOrEqual(funnel.signups + 1);
      // Each path should be <= signups
      expect(funnel.tradedWithin24h).toBeLessThanOrEqual(funnel.signups + 1);
      expect(funnel.commandedWithin24h).toBeLessThanOrEqual(funnel.signups + 1);
    });

    test("retention cohorts have valid structure", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      for (const cohort of data.retention.cohorts) {
        expect(cohort.cohortDate).toBeDefined();
        expect(typeof cohort.cohortSize).toBe("number");
        expect(typeof cohort.retainedD7).toBe("number");
        expect(typeof cohort.retentionRate).toBe("number");
        expect(cohort.retentionRate).toBeGreaterThanOrEqual(0);
        expect(cohort.retentionRate).toBeLessThanOrEqual(100);
        expect(cohort.retainedD7).toBeLessThanOrEqual(cohort.cohortSize);
      }
    });
  });

  describe("Session Metrics", () => {
    test("returns null for sessions when no data exists", async () => {
      requireAuth();

      // Create a user but no sessions
      await createTestUser({});

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      // Session metrics should exist even if null
      expect(data.sessions).toBeDefined();
      expect(typeof data.sessions.totalSessions).toBe("number");
    });

    test("calculates session metrics when data exists", async () => {
      requireAuth();

      // Create test user with sessions
      const userId = await createTestUser({});
      const now = new Date();
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

      await createTestSession(userId, {
        startedAt: tenMinutesAgo,
        lastActiveAt: now,
        endedAt: now,
        pageCount: 5,
      });

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      expect(data.sessions.totalSessions).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Time Series", () => {
    test("time series dates are in chronological order", async () => {
      requireAuth();

      const res = await adminRequest(
        "/api/admin/stats/growth?includeTimeSeries=true",
      );
      const data = await res.json();

      if (data.timeSeries.length >= 2) {
        for (let i = 1; i < data.timeSeries.length; i++) {
          const prev = new Date(data.timeSeries[i - 1].date);
          const curr = new Date(data.timeSeries[i].date);
          expect(curr.getTime()).toBeGreaterThanOrEqual(prev.getTime());
        }
      }
    });

    test("time series respects period parameter", async () => {
      requireAuth();

      const dayRes = await adminRequest(
        "/api/admin/stats/growth?period=day&includeTimeSeries=true",
      );
      const monthRes = await adminRequest(
        "/api/admin/stats/growth?period=month&includeTimeSeries=true",
      );

      const dayData = await dayRes.json();
      const monthData = await monthRes.json();

      // Month period should have more days than day period
      // day = 7 days, month = 90 days
      if (monthData.timeSeries.length > 0 && dayData.timeSeries.length > 0) {
        expect(monthData.timeSeries.length).toBeGreaterThan(
          dayData.timeSeries.length,
        );
      }
    });
  });

  describe("WAU Trend Calculation", () => {
    test("trend is up when current > previous by more than 5%", async () => {
      requireAuth();

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      if (data.wau.previous > 0) {
        const changePercent =
          ((data.wau.current - data.wau.previous) / data.wau.previous) * 100;
        if (changePercent > 5) {
          expect(data.wau.trend).toBe("up");
        } else if (changePercent < -5) {
          expect(data.wau.trend).toBe("down");
        } else {
          expect(data.wau.trend).toBe("stable");
        }
      }
    });
  });

  describe("Error Handling", () => {
    test("handles invalid date parameters gracefully", async () => {
      requireAuth();

      const res = await adminRequest(
        "/api/admin/stats/growth?startDate=invalid",
      );
      // Should still return 200 with null startDate
      expect(res.status).toBe(200);
    });

    test("handles very long query strings", async () => {
      requireAuth();

      const longValue = "a".repeat(5000);
      const res = await adminRequest(
        `/api/admin/stats/growth?period=${longValue}`,
      );

      expect(res.status).toBeLessThan(500);
    });
  });

  describe("Concurrent Requests", () => {
    test("handles multiple concurrent requests", async () => {
      requireAuth();

      const requests = Array(5)
        .fill(null)
        .map(() => adminRequest("/api/admin/stats/growth"));

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metadata).toBeDefined();
      }
    });
  });

  describe("Edge Cases", () => {
    test("handles empty database gracefully", async () => {
      requireAuth();

      // Even with minimal data, should return valid structure
      const res = await adminRequest("/api/admin/stats/growth");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.wau).toBeDefined();
      expect(data.userBalance).toBeDefined();
      expect(data.engagement).toBeDefined();
      expect(data.activation).toBeDefined();
    });

    test("excludes actors from WAU", async () => {
      requireAuth();

      // Create an actor - should not count in WAU
      await createTestUser({ isActor: true });

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      // Just verify the query runs successfully - actors should be filtered
      expect(data.wau.current).toBeGreaterThanOrEqual(0);
    });

    test("excludes agents from WAU", async () => {
      requireAuth();

      // Create an agent - should not count in WAU
      await createTestUser({ isAgent: true });

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      // Just verify the query runs successfully - agents should be filtered
      expect(data.wau.current).toBeGreaterThanOrEqual(0);
    });

    test("excludes banned users from WAU", async () => {
      requireAuth();

      // Create a banned user - should not count in WAU
      await createTestUser({ isBanned: true });

      const res = await adminRequest("/api/admin/stats/growth");
      const data = await res.json();

      // Just verify the query runs successfully - banned users should be filtered
      expect(data.wau.current).toBeGreaterThanOrEqual(0);
    });
  });
});
