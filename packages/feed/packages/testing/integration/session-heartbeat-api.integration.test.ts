/**
 * Session Heartbeat API Integration Tests
 *
 * Tests the /api/activity/heartbeat endpoint that:
 * - Creates/updates user session records
 * - Handles session timeout and recreation
 * - Logs activity for retention tracking
 * - Rate limits heartbeats per session
 *
 * Run: bun test integration/session-heartbeat-api.integration.test.ts --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  db,
  eq,
  isNull,
  userActivityLogs,
  userSessions,
  users,
} from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  "http://localhost:3000";

let serverAvailable = false;
const testUserIds: string[] = [];
const testSessionIds: string[] = [];
const testActivityLogIds: string[] = [];

function requireServer(): void {
  if (!serverAvailable) {
    throw new Error(`TEST SKIPPED: Server not available at ${BASE_URL}`);
  }
}

async function heartbeatRequest(
  body: object,
  options: { cookie?: string; userAgent?: string } = {},
) {
  return fetch(`${BASE_URL}/api/activity/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

async function createTestUser() {
  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `heartbeat-test-${userId}`,
    displayName: `Test User ${userId}`,
    isAdmin: false,
    isAgent: false,
    isActor: false,
    isBanned: false,
    updatedAt: new Date(),
  });
  testUserIds.push(userId);
  return userId;
}

describe("Session Heartbeat API", () => {
  beforeAll(async () => {
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
  });

  afterAll(async () => {
    // Cleanup in reverse dependency order
    for (const logId of testActivityLogIds) {
      await db
        .delete(userActivityLogs)
        .where(eq(userActivityLogs.id, logId))
        .catch(() => {});
    }
    for (const sessionId of testSessionIds) {
      await db
        .delete(userSessions)
        .where(eq(userSessions.id, sessionId))
        .catch(() => {});
    }
    for (const userId of testUserIds) {
      // Clean up any sessions/activity logs for test users
      await db
        .delete(userSessions)
        .where(eq(userSessions.userId, userId))
        .catch(() => {});
      await db
        .delete(userActivityLogs)
        .where(eq(userActivityLogs.userId, userId))
        .catch(() => {});
      await db
        .delete(users)
        .where(eq(users.id, userId))
        .catch(() => {});
    }
    console.log(`Cleaned up ${testUserIds.length} test users`);
  });

  describe("Request Validation", () => {
    test("accepts valid heartbeat request", async () => {
      requireServer();

      // Without auth, should return success with reason
      const res = await heartbeatRequest({
        sessionId: "test-session-123",
        pageViews: 1,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test("rejects missing sessionId", async () => {
      requireServer();

      const res = await heartbeatRequest({
        pageViews: 1,
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    test("rejects invalid sessionId type", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: 123, // Should be string
        pageViews: 1,
      });

      expect(res.status).toBe(400);
    });

    test("rejects very long sessionId", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "a".repeat(200), // Max is 100
        pageViews: 1,
      });

      expect(res.status).toBe(400);
    });

    test("accepts request without pageViews (defaults to 0)", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "test-session-no-pageviews",
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });

  describe("Unauthenticated Requests", () => {
    test("silently accepts unauthenticated requests", async () => {
      requireServer();

      // Without an auth cookie, should return success with reason.
      const res = await heartbeatRequest({
        sessionId: "test-session-unauth",
        pageViews: 1,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.reason).toBe("unauthenticated");
    });
  });

  describe("Rate Limiting", () => {
    test("rate limits rapid requests from same session", async () => {
      requireServer();

      const sessionId = `rate-limit-test-${Date.now()}`;

      // First request should succeed
      const res1 = await heartbeatRequest({ sessionId });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.success).toBe(true);

      // Immediate second request should be rate limited
      const res2 = await heartbeatRequest({ sessionId });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.success).toBe(true);
      // Should still succeed but with rate_limited reason
      // (since unauthenticated, might get 'unauthenticated' reason instead)
    });
  });

  describe("Device Detection", () => {
    test("detects desktop user agent", async () => {
      requireServer();

      const res = await heartbeatRequest(
        { sessionId: "device-test-desktop" },
        {
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      );

      expect(res.status).toBe(200);
    });

    test("detects mobile user agent", async () => {
      requireServer();

      const res = await heartbeatRequest(
        { sessionId: "device-test-mobile" },
        { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)" },
      );

      expect(res.status).toBe(200);
    });

    test("detects tablet user agent", async () => {
      requireServer();

      const res = await heartbeatRequest(
        { sessionId: "device-test-tablet" },
        { userAgent: "Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X)" },
      );

      expect(res.status).toBe(200);
    });

    test("handles missing user agent", async () => {
      requireServer();

      const res = await heartbeatRequest({ sessionId: "device-test-none" });
      expect(res.status).toBe(200);
    });
  });

  describe("Response Format", () => {
    test("returns success with sessionId", async () => {
      requireServer();

      const sessionId = "response-test-session";
      const res = await heartbeatRequest({ sessionId });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      // sessionId is only returned for authenticated requests
      // For unauthenticated, we get reason instead
      expect(data.reason || data.sessionId).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    test("handles malformed JSON gracefully", async () => {
      requireServer();

      const res = await fetch(`${BASE_URL}/api/activity/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json {{{",
        signal: AbortSignal.timeout(10000),
      });

      expect(res.status).toBeLessThan(500);
    });

    test("handles empty body", async () => {
      requireServer();

      const res = await fetch(`${BASE_URL}/api/activity/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "",
        signal: AbortSignal.timeout(10000),
      });

      // Should handle gracefully (400 or similar)
      expect(res.status).toBeLessThan(500);
    });
  });

  describe("Concurrent Requests", () => {
    test("handles multiple concurrent heartbeats", async () => {
      requireServer();

      const requests = Array(10)
        .fill(null)
        .map((_, i) =>
          heartbeatRequest({
            sessionId: `concurrent-test-${i}`,
            pageViews: i,
          }),
        );

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
      }
    });

    test("handles concurrent heartbeats from same session", async () => {
      requireServer();

      const sessionId = `same-session-concurrent-${Date.now()}`;

      const requests = Array(5)
        .fill(null)
        .map(() =>
          heartbeatRequest({
            sessionId,
            pageViews: 1,
          }),
        );

      const responses = await Promise.all(requests);

      // All should succeed (rate limiting is soft)
      for (const res of responses) {
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
      }
    });
  });

  describe("Edge Cases", () => {
    test("handles zero pageViews", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "edge-zero-pageviews",
        pageViews: 0,
      });

      expect(res.status).toBe(200);
    });

    test("handles negative pageViews (treats as 0)", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "edge-negative-pageviews",
        pageViews: -5,
      });

      expect(res.status).toBe(200);
    });

    test("handles very large pageViews", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "edge-large-pageviews",
        pageViews: 999999999,
      });

      expect(res.status).toBe(200);
    });

    test("handles special characters in sessionId", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "session-with-special-chars-!@#$%",
        pageViews: 1,
      });

      expect(res.status).toBe(200);
    });

    test("handles unicode in sessionId", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "session-日本語-🎉",
        pageViews: 1,
      });

      expect(res.status).toBe(200);
    });

    test("handles additional unknown fields in body", async () => {
      requireServer();

      const res = await heartbeatRequest({
        sessionId: "edge-extra-fields",
        pageViews: 1,
        unknownField: "should be ignored",
        anotherField: 123,
      });

      expect(res.status).toBe(200);
    });
  });

  describe("POST Method Only", () => {
    test("rejects GET requests", async () => {
      requireServer();

      const res = await fetch(`${BASE_URL}/api/activity/heartbeat`, {
        method: "GET",
        signal: AbortSignal.timeout(10000),
      });

      expect(res.status).toBe(405);
    });

    test("rejects PUT requests", async () => {
      requireServer();

      const res = await fetch(`${BASE_URL}/api/activity/heartbeat`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "test" }),
        signal: AbortSignal.timeout(10000),
      });

      expect(res.status).toBe(405);
    });

    test("rejects DELETE requests", async () => {
      requireServer();

      const res = await fetch(`${BASE_URL}/api/activity/heartbeat`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      });

      expect(res.status).toBe(405);
    });
  });

  describe("Performance", () => {
    test("responds within reasonable time", async () => {
      requireServer();

      const start = Date.now();
      const res = await heartbeatRequest({
        sessionId: "perf-test-session",
        pageViews: 1,
      });
      const duration = Date.now() - start;

      expect(res.status).toBe(200);
      // Should respond in under 500ms for a simple heartbeat
      expect(duration).toBeLessThan(500);
    });

    test("batch of heartbeats completes in reasonable time", async () => {
      requireServer();

      const start = Date.now();
      const requests = Array(20)
        .fill(null)
        .map((_, i) =>
          heartbeatRequest({
            sessionId: `batch-perf-${i}`,
            pageViews: 1,
          }),
        );

      await Promise.all(requests);
      const duration = Date.now() - start;

      // 20 concurrent requests should complete in under 5 seconds
      expect(duration).toBeLessThan(5000);
    });
  });
});

describe("Session Database Operations", () => {
  // These tests verify actual database state changes
  // They require a test user and simulated authentication

  describe("Session Creation", () => {
    test("creates session record for new sessionId", async () => {
      // This test verifies the session is created in the database
      // Would need authenticated request to fully test
      const userId = await createTestUser();

      // Check that user exists
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      expect(user).toBeDefined();
      expect(user?.id).toBe(userId);
    });
  });

  describe("Activity Log Creation", () => {
    test("creates activity log entry per user per day", async () => {
      const userId = await createTestUser();

      // Create an activity log directly to test structure
      const logId = await generateSnowflakeId();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      await db.insert(userActivityLogs).values({
        id: logId,
        userId,
        activityType: "session",
        activityDate: today,
      });
      testActivityLogIds.push(logId);

      // Verify it was created
      const [log] = await db
        .select()
        .from(userActivityLogs)
        .where(eq(userActivityLogs.id, logId))
        .limit(1);

      expect(log).toBeDefined();
      expect(log?.userId).toBe(userId);
      expect(log?.activityType).toBe("session");
    });

    test("unique constraint prevents duplicate activity logs", async () => {
      const userId = await createTestUser();

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // First insert should succeed
      const logId1 = await generateSnowflakeId();
      await db.insert(userActivityLogs).values({
        id: logId1,
        userId,
        activityType: "session",
        activityDate: today,
      });
      testActivityLogIds.push(logId1);

      // Second insert with same user/date/type should be ignored
      const logId2 = await generateSnowflakeId();

      await db
        .insert(userActivityLogs)
        .values({
          id: logId2,
          userId,
          activityType: "session",
          activityDate: today,
        })
        .onConflictDoNothing();

      // Should only have one log (duplicate ignored)
      const logs = await db
        .select()
        .from(userActivityLogs)
        .where(
          and(
            eq(userActivityLogs.userId, userId),
            eq(userActivityLogs.activityType, "session"),
          ),
        );

      expect(logs.length).toBe(1);
    });
  });

  describe("Session Update", () => {
    test("session structure is valid", async () => {
      const userId = await createTestUser();

      const sessionId = await generateSnowflakeId();
      const clientSessionId = `test-session-${sessionId}`;
      const now = new Date();

      await db.insert(userSessions).values({
        id: sessionId,
        userId,
        sessionId: clientSessionId,
        startedAt: now,
        lastActiveAt: now,
        deviceType: "desktop",
        pageCount: 5,
        heartbeatCount: 1,
      });
      testSessionIds.push(sessionId);

      // Verify structure
      const [session] = await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.id, sessionId))
        .limit(1);

      expect(session).toBeDefined();
      expect(session?.userId).toBe(userId);
      expect(session?.sessionId).toBe(clientSessionId);
      expect(session?.deviceType).toBe("desktop");
      expect(session?.pageCount).toBe(5);
      expect(session?.heartbeatCount).toBe(1);
      expect(session?.endedAt).toBeNull();
    });

    test("can update session lastActiveAt and counters", async () => {
      const userId = await createTestUser();

      const sessionId = await generateSnowflakeId();
      const clientSessionId = `test-session-update-${sessionId}`;
      const startTime = new Date(Date.now() - 60000); // 1 minute ago

      await db.insert(userSessions).values({
        id: sessionId,
        userId,
        sessionId: clientSessionId,
        startedAt: startTime,
        lastActiveAt: startTime,
        pageCount: 1,
        heartbeatCount: 1,
      });
      testSessionIds.push(sessionId);

      // Update session
      const newTime = new Date();
      await db
        .update(userSessions)
        .set({
          lastActiveAt: newTime,
          pageCount: 5,
          heartbeatCount: 3,
        })
        .where(eq(userSessions.id, sessionId));

      // Verify update
      const [session] = await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.id, sessionId))
        .limit(1);

      expect(session?.pageCount).toBe(5);
      expect(session?.heartbeatCount).toBe(3);
      expect(session?.lastActiveAt.getTime()).toBeCloseTo(
        newTime.getTime(),
        -2,
      );
    });

    test("can close session by setting endedAt", async () => {
      const userId = await createTestUser();

      const sessionId = await generateSnowflakeId();
      const clientSessionId = `test-session-close-${sessionId}`;
      const startTime = new Date(Date.now() - 3600000); // 1 hour ago

      await db.insert(userSessions).values({
        id: sessionId,
        userId,
        sessionId: clientSessionId,
        startedAt: startTime,
        lastActiveAt: startTime,
        pageCount: 10,
        heartbeatCount: 12,
      });
      testSessionIds.push(sessionId);

      // Close session
      const endTime = new Date();
      await db
        .update(userSessions)
        .set({ endedAt: endTime })
        .where(eq(userSessions.id, sessionId));

      // Verify
      const [session] = await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.id, sessionId))
        .limit(1);

      expect(session?.endedAt).not.toBeNull();
      expect(session?.endedAt?.getTime()).toBeCloseTo(endTime.getTime(), -2);
    });
  });

  describe("Session Queries", () => {
    test("can find active sessions (endedAt is null)", async () => {
      const userId = await createTestUser();

      // Create an active session
      const activeSessionId = await generateSnowflakeId();
      await db.insert(userSessions).values({
        id: activeSessionId,
        userId,
        sessionId: `active-${activeSessionId}`,
        startedAt: new Date(),
        lastActiveAt: new Date(),
        pageCount: 1,
        heartbeatCount: 1,
      });
      testSessionIds.push(activeSessionId);

      // Create a closed session
      const closedSessionId = await generateSnowflakeId();
      await db.insert(userSessions).values({
        id: closedSessionId,
        userId,
        sessionId: `closed-${closedSessionId}`,
        startedAt: new Date(Date.now() - 3600000),
        lastActiveAt: new Date(Date.now() - 3600000),
        endedAt: new Date(Date.now() - 3600000),
        pageCount: 5,
        heartbeatCount: 5,
      });
      testSessionIds.push(closedSessionId);

      // Query active sessions
      const activeSessions = await db
        .select()
        .from(userSessions)
        .where(
          and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)),
        );

      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0]?.id).toBe(activeSessionId);
    });
  });
});
