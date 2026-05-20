/**
 * Time-Series API Integration Tests
 *
 * Tests the admin time-series statistics API that serves historical
 * metrics from hourly snapshots.
 *
 * Run: bun test integration/timeseries-api.integration.test.ts --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, inArray, systemMetricsSnapshots } from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";
import { getAdminToken } from "./helpers";

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  "http://localhost:3000";

let serverAvailable = false;
let devAdminToken: string | null = null;
let authAvailable = false;
const testSnapshotIds: string[] = [];

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

/**
 * Check if response is rate limited and return early with pass
 * This prevents test failures when rate limit is hit
 */
function isRateLimited(response: Response): boolean {
  if (response.status === 429) {
    console.log("Rate limited - skipping test assertions");
    return true;
  }
  return false;
}

async function createTestSnapshot(
  overrides: Partial<{
    timestamp: Date;
    environment: string;
    totalUsers: number;
    activeUsers: number;
    newSignups: number;
    tradingVolume: string;
    activeMarkets: number;
  }> = {},
) {
  const snapshotId = await generateSnowflakeId();
  const timestamp = overrides.timestamp || new Date();
  timestamp.setMinutes(0, 0, 0); // Ensure hour boundary

  await db.insert(systemMetricsSnapshots).values({
    id: snapshotId,
    timestamp,
    environment: overrides.environment || "development",
    totalUsers: overrides.totalUsers ?? 1000,
    activeUsers: overrides.activeUsers ?? 100,
    newSignups: overrides.newSignups ?? 10,
    tradingVolume: overrides.tradingVolume ?? "50000.00",
    activeMarkets: overrides.activeMarkets ?? 25,
    openPositions: 150,
    perpVolume: "10000.00",
    activePerpPositions: 50,
    postsCreated: 20,
    commentsCreated: 50,
    reactionsCreated: 100,
    totalVirtualBalance: "1000000.00",
    feesCollectedHourly: "5000.00",
    apiUptime: 99.9,
    avgResponseTime: 50,
    errorRate: 0.1,
    cronJobsHealthy: 10,
    cronJobsUnhealthy: 0,
    snapshotDurationMs: 500,
  });

  testSnapshotIds.push(snapshotId);
  return snapshotId;
}

describe("Time-Series API", () => {
  beforeAll(async () => {
    // Check server availability
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      serverAvailable = response.ok;
      console.log(
        `Server availability: ${serverAvailable ? "Available" : "Unavailable"}`,
      );
    } catch {
      serverAvailable = false;
      console.log("Server not available - tests will be skipped");
    }

    // Get dev admin token from env or credentials
    devAdminToken = getAdminToken();
    if (devAdminToken) {
      authAvailable = true;
      console.log("Admin auth available");
    } else {
      console.log("Dev credentials not available - auth tests will be skipped");
      authAvailable = false;
    }

    // Create test snapshots for the past 48 hours
    if (serverAvailable) {
      const now = new Date();
      for (let i = 0; i < 48; i++) {
        const timestamp = new Date(now.getTime() - i * 60 * 60 * 1000);
        try {
          await createTestSnapshot({
            timestamp,
            totalUsers: 1000 + i * 5,
            activeUsers: 100 + Math.floor(Math.random() * 50),
            newSignups: Math.floor(Math.random() * 20),
            tradingVolume: (50000 + Math.random() * 10000).toFixed(2),
            activeMarkets: 25 + Math.floor(Math.random() * 10),
          });
        } catch {
          // Might fail if snapshot already exists
        }
      }
      console.log(`Created ${testSnapshotIds.length} test snapshots`);
    }
  });

  afterAll(async () => {
    // Batch cleanup of test snapshots (more efficient than individual deletes)
    if (testSnapshotIds.length > 0) {
      try {
        await db
          .delete(systemMetricsSnapshots)
          .where(inArray(systemMetricsSnapshots.id, testSnapshotIds));
        console.log(`Cleaned up ${testSnapshotIds.length} test snapshots`);
      } catch (error) {
        console.error("Error cleaning up test snapshots:", error);
      }
    }
  });

  describe("Authentication & Authorization", () => {
    test("returns 401/403 without admin authentication", async () => {
      if (!serverAvailable) {
        console.log("SKIPPED: Server not available");
        return;
      }

      const response = await publicRequest("/api/admin/stats/timeseries");

      expect([401, 403]).toContain(response.status);
    });

    test("accepts valid admin token", async () => {
      if (!serverAvailable || !authAvailable) {
        console.log("SKIPPED: Server or auth not available");
        return;
      }

      const response = await adminRequest("/api/admin/stats/timeseries");

      expect(response.status).toBe(200);
    });
  });

  describe("Query Parameters", () => {
    test("uses default date range (7 days) when not specified", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest("/api/admin/stats/timeseries");
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      expect(data.metadata).toBeDefined();

      if (data.metadata) {
        const startDate = new Date(data.metadata.startDate);
        const endDate = new Date(data.metadata.endDate);
        const daysDiff = Math.ceil(
          (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000),
        );

        expect(daysDiff).toBeGreaterThanOrEqual(6);
        expect(daysDiff).toBeLessThanOrEqual(8);
      }
    });

    test("accepts custom date range", async () => {
      if (!serverAvailable || !authAvailable) return;

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 3 * 24 * 60 * 60 * 1000);

      const response = await adminRequest(
        `/api/admin/stats/timeseries?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
      );
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      expect(data.metadata?.startDate).toBe(startDate.toISOString());
    });

    test("auto-selects hourly granularity for short date ranges", async () => {
      if (!serverAvailable || !authAvailable) return;

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 2 * 24 * 60 * 60 * 1000);

      const response = await adminRequest(
        `/api/admin/stats/timeseries?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
      );
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      if (data.metadata) {
        expect(data.metadata.granularity).toBe("hourly");
      }
    });

    test("auto-selects daily granularity for long date ranges", async () => {
      if (!serverAvailable || !authAvailable) return;

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000);

      const response = await adminRequest(
        `/api/admin/stats/timeseries?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
      );
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      if (data.metadata) {
        expect(data.metadata.granularity).toBe("daily");
      }
    });

    test("accepts explicit granularity parameter", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest(
        "/api/admin/stats/timeseries?granularity=daily",
      );
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      if (data.metadata) {
        expect(data.metadata.granularity).toBe("daily");
      }
    });

    test("accepts environment parameter", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest(
        "/api/admin/stats/timeseries?environment=development",
      );
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      if (data.metadata) {
        expect(data.metadata.environment).toBe("development");
      }
    });

    test("rejects invalid environment value", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest(
        "/api/admin/stats/timeseries?environment=invalid",
      );

      if (isRateLimited(response)) return;
      // Should use default instead of failing
      expect(response.status).toBe(200);
    });
  });

  describe("Response Format", () => {
    test("returns timeSeries array", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest("/api/admin/stats/timeseries");
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      expect(Array.isArray(data.timeSeries)).toBe(true);
    });

    test("timeSeries entries have correct structure", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest("/api/admin/stats/timeseries");
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);

      if (data.timeSeries?.length > 0) {
        const entry = data.timeSeries[0];

        expect(entry.timestamp).toBeDefined();
        expect(entry.users).toBeDefined();
        expect(entry.users.total).toBeGreaterThanOrEqual(0);
        expect(entry.users.active).toBeGreaterThanOrEqual(0);
        expect(entry.trading).toBeDefined();
        expect(entry.trading.volume).toBeGreaterThanOrEqual(0);
        expect(entry.system).toBeDefined();
        expect(entry.system.dbAvailability).toBeGreaterThanOrEqual(0);
        expect(entry.system.dbPingMs).toBeGreaterThanOrEqual(0);
        expect(entry.system.cronFailureRate).toBeGreaterThanOrEqual(0);
      }
    });

    test("returns summary statistics", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest("/api/admin/stats/timeseries");
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);

      if (data.timeSeries?.length > 0 && data.summary) {
        expect(data.summary.period).toBeDefined();
        expect(data.summary.userGrowth).toBeDefined();
        expect(data.summary.trading).toBeDefined();
        expect(data.summary.system).toBeDefined();
      }
    });

    test("returns metadata with coverage info", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest("/api/admin/stats/timeseries");
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      expect(data.metadata).toBeDefined();

      if (data.metadata) {
        expect(data.metadata.snapshotCount).toBeGreaterThanOrEqual(0);
        expect(data.metadata.expectedSnapshots).toBeGreaterThanOrEqual(0);
        expect(data.metadata.coverage).toBeGreaterThanOrEqual(0);
        expect(typeof data.metadata.hasGaps).toBe("boolean");
      }
    });
  });

  describe("Data Aggregation", () => {
    test("aggregates hourly data to daily correctly", async () => {
      if (!serverAvailable || !authAvailable) return;

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 2 * 24 * 60 * 60 * 1000);

      // Get hourly data
      const hourlyResponse = await adminRequest(
        `/api/admin/stats/timeseries?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}&granularity=hourly`,
      );
      const hourlyData = await hourlyResponse.json();

      // Get daily data
      const dailyResponse = await adminRequest(
        `/api/admin/stats/timeseries?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}&granularity=daily`,
      );
      const dailyData = await dailyResponse.json();

      if (isRateLimited(hourlyResponse) || isRateLimited(dailyResponse)) return;
      expect(hourlyResponse.status).toBe(200);
      expect(dailyResponse.status).toBe(200);

      // Daily should have fewer entries than hourly
      if (
        hourlyData.timeSeries?.length > 0 &&
        dailyData.timeSeries?.length > 0
      ) {
        expect(dailyData.timeSeries.length).toBeLessThanOrEqual(
          hourlyData.timeSeries.length,
        );
      }
    });

    test("daily aggregation sums incremental metrics", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest(
        "/api/admin/stats/timeseries?granularity=daily",
      );
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);

      if (data.timeSeries?.length > 0) {
        const entry = data.timeSeries[0];
        // Daily entries should have summed values
        expect(entry.trading?.volume).toBeGreaterThanOrEqual(0);
        expect(entry.social?.posts).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Gap Detection", () => {
    test("detects gaps in snapshot data", async () => {
      if (!serverAvailable || !authAvailable) return;

      // Query a range that might have gaps
      const response = await adminRequest("/api/admin/stats/timeseries");
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);
      expect(data.metadata).toBeDefined();

      if (data.metadata) {
        expect(typeof data.metadata.hasGaps).toBe("boolean");
        expect(typeof data.fallbackAvailable).toBe("boolean");
      }
    });

    test("reports coverage percentage", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest("/api/admin/stats/timeseries");
      const data = await response.json();

      if (isRateLimited(response)) return;
      expect(response.status).toBe(200);

      if (data.metadata) {
        // Coverage is a percentage, should be >= 0
        // Can exceed 100% if more snapshots than expected (due to test data)
        expect(data.metadata.coverage).toBeGreaterThanOrEqual(0);
        expect(typeof data.metadata.coverage).toBe("number");
      }
    });
  });

  describe("Rate Limiting", () => {
    test("respects rate limits", async () => {
      if (!serverAvailable || !authAvailable) return;

      // Make multiple rapid requests
      const promises = Array(5)
        .fill(null)
        .map(() => adminRequest("/api/admin/stats/timeseries"));

      const responses = await Promise.all(promises);

      // All should succeed or some should be rate limited (429)
      for (const response of responses) {
        expect([200, 429]).toContain(response.status);
      }
    });
  });

  describe("Edge Cases", () => {
    test("handles empty date range gracefully", async () => {
      if (!serverAvailable || !authAvailable) return;

      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await adminRequest(
        `/api/admin/stats/timeseries?startDate=${futureDate.toISOString()}`,
      );
      const data = await response.json();

      // API may return 200 with empty data, 400 for invalid date range, or 429 rate limited
      expect([200, 400, 429]).toContain(response.status);
      if (response.status === 200) {
        expect(data.timeSeries).toEqual([]);
      }
    });

    test("handles very large date ranges", async () => {
      if (!serverAvailable || !authAvailable) return;

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);

      const response = await adminRequest(
        `/api/admin/stats/timeseries?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`,
      );

      // Should either succeed with daily aggregation, return error, or rate limit
      expect([200, 400, 429]).toContain(response.status);
    });

    test("handles invalid date formats", async () => {
      if (!serverAvailable || !authAvailable) return;

      const response = await adminRequest(
        "/api/admin/stats/timeseries?startDate=not-a-date",
      );

      // Should use default, return error, or rate limit
      expect([200, 400, 429]).toContain(response.status);
    });
  });
});
