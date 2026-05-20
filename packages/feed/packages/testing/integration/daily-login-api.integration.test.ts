/**
 * Daily Login API - Integration Tests
 *
 * Tests the full daily login flow with real database.
 * Covers:
 * - Authentication and authorization
 * - Real database operations via DailyLoginService
 * - Concurrency and race conditions
 * - Idempotency
 * - Error handling
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { DailyLoginService } from '@babylon/api';
import { db, eq, sql, users } from '@babylon/db';
import { generateSnowflakeId, POINTS } from '@babylon/shared';
import { waitForEndpointAvailability } from './helpers';

setDefaultTimeout(30000);

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let dbAvailable = false;
let testUserId: string | null = null;

// ─── Setup Helpers ───────────────────────────────────────────────────────────

async function checkServerHealth(): Promise<boolean> {
  return waitForEndpointAvailability(
    `${BASE_URL}/api/users/daily-login`,
    {},
    (response) => response.status !== 404 && response.status < 500,
    15,
    10000
  );
}

async function checkDatabaseHealth(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    // Check both DB connection AND that daily login columns exist
    await db.execute(sql`SELECT "dailyLoginStreak" FROM "User" LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/** Log skip reason when infrastructure is unavailable */
function skipIfNoServer(): boolean {
  if (!serverAvailable) {
    console.log('⏭️ Skipped: Server not available');
    return true;
  }
  return false;
}

function skipIfNoDb(): boolean {
  if (!dbAvailable) {
    console.log('⏭️ Skipped: Database not available');
    return true;
  }
  return false;
}

async function createTestUser(): Promise<string> {
  const id = await generateSnowflakeId();
  const privyId = `test-privy-${id}`;

  await db.insert(users).values({
    id,
    privyId,
    username: `test-daily-login-${id}`,
    displayName: 'Test User',
    profileComplete: true,
    isActor: false,
    isAgent: false,
    dailyLoginStreak: 0,
    longestStreak: 0,
    totalDailyLogins: 0,
    lastDailyLogin: null,
    updatedAt: new Date(),
  });

  return id;
}

async function deleteTestUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

async function getUserStreak(userId: string) {
  const [user] = await db
    .select({
      dailyLoginStreak: users.dailyLoginStreak,
      lastDailyLogin: users.lastDailyLogin,
      longestStreak: users.longestStreak,
      totalDailyLogins: users.totalDailyLogins,
      virtualBalance: users.virtualBalance,
      bonusPoints: users.bonusPoints,
      reputationPoints: users.reputationPoints,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user;
}

async function setUserStreak(
  userId: string,
  streak: number,
  lastDailyLogin: Date | null,
  options?: { longestStreak?: number; totalDailyLogins?: number }
): Promise<void> {
  await db
    .update(users)
    .set({
      dailyLoginStreak: streak,
      lastDailyLogin,
      longestStreak: options?.longestStreak ?? streak,
      totalDailyLogins: options?.totalDailyLogins ?? streak,
    })
    .where(eq(users.id, userId));
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe('Daily Login - Integration Tests', () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth();
    dbAvailable = await checkDatabaseHealth();

    if (!serverAvailable) {
      console.warn('⚠️  Server not available - HTTP tests will be skipped');
    }
    if (!dbAvailable) {
      console.warn('⚠️  Database not available - DB tests will be skipped');
    }

    if (dbAvailable) {
      testUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && testUserId) {
      await deleteTestUser(testUserId);
    }
  });

  // ─── HTTP Authentication Tests ───────────────────────────────────────────

  describe('HTTP - Authentication', () => {
    // Auth failures should return 401 Unauthorized, not 500.
    // 500 would indicate a server bug that should be investigated.
    test('GET without auth returns 401', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });

    test('POST without auth returns 401', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });

    test('invalid Bearer token is rejected', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        headers: { Authorization: 'Bearer invalid-token-xyz' },
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });

    test('malformed auth header is rejected', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        headers: { Authorization: 'NotBearer token' },
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });

    test('empty Bearer token is rejected', async () => {
      if (skipIfNoServer()) return;

      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        headers: { Authorization: 'Bearer ' },
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── HTTP Method Tests ───────────────────────────────────────────────────

  describe('HTTP - Methods', () => {
    test('PUT returns 405', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'PUT',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(405);
    });

    test('DELETE returns 405', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(405);
    });

    test('PATCH returns 405', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        method: 'PATCH',
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).toBe(405);
    });
  });

  // ─── HTTP Edge Cases ─────────────────────────────────────────────────────

  describe('HTTP - Edge Cases', () => {
    test('endpoint exists (not 404)', async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/api/users/daily-login`, {
        signal: AbortSignal.timeout(10000),
      });
      expect(res.status).not.toBe(404);
    });

    test('concurrent requests handled gracefully', async () => {
      if (skipIfNoServer()) return;

      const requests = Array.from({ length: 10 }, () =>
        fetch(`${BASE_URL}/api/users/daily-login`, {
          signal: AbortSignal.timeout(10000),
        })
      );

      const responses = await Promise.all(requests);
      for (const res of responses) {
        // Should be auth error or rate limit - 500 would indicate a server crash
        expect([401, 429]).toContain(res.status);
      }
    });
  });
});

// ─── Database Integration Tests ──────────────────────────────────────────────

describe('Daily Login - Database Integration', () => {
  let localTestUserId: string | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();
    if (dbAvailable) {
      localTestUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && localTestUserId) {
      await deleteTestUser(localTestUserId);
    }
  });

  describe('Initial State', () => {
    test('new user has zero streak', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const user = await getUserStreak(localTestUserId);
      expect(user).toBeDefined();
      expect(user!.dailyLoginStreak).toBe(0);
      expect(user!.lastDailyLogin).toBeNull();
      expect(user!.longestStreak).toBe(0);
      expect(user!.totalDailyLogins).toBe(0);
    });
  });

  describe('Streak Updates', () => {
    test('setUserStreak correctly updates database', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const testDate = new Date('2025-01-15T12:00:00.000Z');
      await setUserStreak(localTestUserId, 5, testDate);

      const user = await getUserStreak(localTestUserId);
      expect(user!.dailyLoginStreak).toBe(5);
      expect(user!.lastDailyLogin?.toISOString()).toBe(testDate.toISOString());
      expect(user!.longestStreak).toBe(5);

      // Reset for other tests
      await setUserStreak(localTestUserId, 0, null);
    });
  });

  describe('Data Integrity', () => {
    test('streak values are integers', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const user = await getUserStreak(localTestUserId);
      expect(Number.isInteger(user!.dailyLoginStreak)).toBe(true);
      expect(Number.isInteger(user!.longestStreak)).toBe(true);
      expect(Number.isInteger(user!.totalDailyLogins)).toBe(true);
    });

    test('virtualBalance is numeric string', async () => {
      if (skipIfNoDb() || !localTestUserId) return;

      const user = await getUserStreak(localTestUserId);
      const balance = Number(user!.virtualBalance);
      expect(Number.isFinite(balance)).toBe(true);
    });
  });
});

// ─── Service Logic Integration ───────────────────────────────────────────────

describe('Daily Login - DailyLoginService Integration', () => {
  let serviceTestUserId: string | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();
    if (dbAvailable) {
      serviceTestUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && serviceTestUserId) {
      await deleteTestUser(serviceTestUserId);
    }
  });

  describe('getStreakInfo', () => {
    test('returns correct info for new user', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      await setUserStreak(serviceTestUserId, 0, null);

      const info = await DailyLoginService.getStreakInfo(serviceTestUserId);

      expect(info.currentStreak).toBe(0);
      expect(info.longestStreak).toBe(0);
      expect(info.canClaim).toBe(true);
      expect(info.lastClaim).toBeNull();
      expect(info.nextReward).toBe(POINTS.DAILY_LOGIN_DAY_1);
    });

    test('throws for invalid userId format', async () => {
      if (skipIfNoDb()) return;

      await expect(
        DailyLoginService.getStreakInfo('invalid-format')
      ).rejects.toThrow('Invalid userId format');
    });

    test('throws for non-existent valid userId', async () => {
      if (skipIfNoDb()) return;

      // Valid snowflake format but doesn't exist
      await expect(
        DailyLoginService.getStreakInfo('123456789012345678')
      ).rejects.toThrow('User not found');
    });

    test('returns effectiveStreak=0 when streak has expired (Bug 1 fix)', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set streak to 50, but lastDailyLogin to 48 hours ago (past 36h grace)
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600000);
      await setUserStreak(serviceTestUserId, 50, fortyEightHoursAgo);

      const info = await DailyLoginService.getStreakInfo(serviceTestUserId);

      // currentStreak should be 0 (effective), not 50 (raw DB value)
      expect(info.currentStreak).toBe(0);
      // longestStreak is historical and should still be 50
      expect(info.longestStreak).toBe(50);
      // Next milestone should be calculated from 0, not 50
      expect(info.nextMilestone).toBe(7);
      expect(info.daysUntilMilestone).toBe(7);
      // Next reward should be for day 1 (since streak will reset)
      expect(info.nextReward).toBe(POINTS.DAILY_LOGIN_DAY_1);
      // Can claim (past grace period)
      expect(info.canClaim).toBe(true);
    });
  });

  describe('claimDailyReward - First Claim', () => {
    test('first claim sets streak to 1 and awards points', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Reset user to clean state
      await setUserStreak(serviceTestUserId, 0, null);
      const beforeUser = await getUserStreak(serviceTestUserId);
      const balanceBefore = Number(beforeUser!.virtualBalance);

      const result =
        await DailyLoginService.claimDailyReward(serviceTestUserId);

      expect(result.success).toBe(true);
      expect(result.streak).toBe(1);
      expect(result.reward).toBe(POINTS.DAILY_LOGIN_DAY_1);
      expect(result.milestoneBonus).toBe(0);
      expect(result.totalAwarded).toBe(POINTS.DAILY_LOGIN_DAY_1);
      expect(result.streakReset).toBe(false);

      // Verify database was updated
      const afterUser = await getUserStreak(serviceTestUserId);
      expect(afterUser!.dailyLoginStreak).toBe(1);
      expect(afterUser!.lastDailyLogin).not.toBeNull();
      expect(afterUser!.totalDailyLogins).toBe(1);
      expect(Number(afterUser!.virtualBalance)).toBe(
        balanceBefore + POINTS.DAILY_LOGIN_DAY_1
      );
    });
  });

  describe('claimDailyReward - Repeat Claim Prevention', () => {
    test('claim within 24h fails with error', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set lastDailyLogin to 1 hour ago
      const oneHourAgo = new Date(Date.now() - 3600000);
      await setUserStreak(serviceTestUserId, 5, oneHourAgo);

      const result =
        await DailyLoginService.claimDailyReward(serviceTestUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot claim yet');
      expect(result.streak).toBe(5); // Unchanged
    });
  });

  describe('claimDailyReward - Grace Period', () => {
    test('claim after 25h continues streak', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set lastDailyLogin to 25 hours ago
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600000);
      await setUserStreak(serviceTestUserId, 5, twentyFiveHoursAgo);

      const result =
        await DailyLoginService.claimDailyReward(serviceTestUserId);

      expect(result.success).toBe(true);
      expect(result.streak).toBe(6); // Incremented from 5
      expect(result.streakReset).toBe(false);
      expect(result.reward).toBe(POINTS.DAILY_LOGIN_DAY_6);
    });
  });

  describe('claimDailyReward - Streak Reset', () => {
    test('claim after 48h resets streak to 1', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set lastDailyLogin to 48 hours ago (past grace period)
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600000);
      await setUserStreak(serviceTestUserId, 50, fortyEightHoursAgo);

      const result =
        await DailyLoginService.claimDailyReward(serviceTestUserId);

      expect(result.success).toBe(true);
      expect(result.streak).toBe(1); // Reset to 1
      expect(result.streakReset).toBe(true);
      expect(result.reward).toBe(POINTS.DAILY_LOGIN_DAY_1);
    });
  });

  describe('claimDailyReward - Milestones', () => {
    test('day 7 awards milestone bonus', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set streak to 6, last claim 25h ago
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600000);
      await setUserStreak(serviceTestUserId, 6, twentyFiveHoursAgo);

      const result =
        await DailyLoginService.claimDailyReward(serviceTestUserId);

      expect(result.success).toBe(true);
      expect(result.streak).toBe(7);
      expect(result.reward).toBe(POINTS.DAILY_LOGIN_DAY_7);
      expect(result.milestoneBonus).toBe(POINTS.DAILY_LOGIN_MILESTONE_7D);
      expect(result.totalAwarded).toBe(
        POINTS.DAILY_LOGIN_DAY_7 + POINTS.DAILY_LOGIN_MILESTONE_7D
      );
    });
  });

  describe('claimDailyReward - Longest Streak', () => {
    test('longestStreak updates when current exceeds it', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set current streak to 9, longest to 10
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600000);
      await db
        .update(users)
        .set({
          dailyLoginStreak: 9,
          longestStreak: 10,
          lastDailyLogin: twentyFiveHoursAgo,
          totalDailyLogins: 9,
        })
        .where(eq(users.id, serviceTestUserId));

      const result =
        await DailyLoginService.claimDailyReward(serviceTestUserId);

      expect(result.success).toBe(true);
      expect(result.streak).toBe(10);

      // longestStreak should stay at 10 (not decrease)
      const user = await getUserStreak(serviceTestUserId);
      expect(user!.longestStreak).toBe(10);
    });

    test('longestStreak increases when beaten', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Set current streak to 10, longest to 10
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600000);
      await db
        .update(users)
        .set({
          dailyLoginStreak: 10,
          longestStreak: 10,
          lastDailyLogin: twentyFiveHoursAgo,
          totalDailyLogins: 10,
        })
        .where(eq(users.id, serviceTestUserId));

      const result =
        await DailyLoginService.claimDailyReward(serviceTestUserId);

      expect(result.success).toBe(true);
      expect(result.streak).toBe(11);

      const user = await getUserStreak(serviceTestUserId);
      expect(user!.longestStreak).toBe(11);
    });
  });

  describe('claimDailyReward - Idempotency', () => {
    test('rapid double-claim only awards once', async () => {
      if (skipIfNoDb() || !serviceTestUserId) return;

      // Reset to clean state
      await setUserStreak(serviceTestUserId, 0, null);
      const beforeUser = await getUserStreak(serviceTestUserId);
      const balanceBefore = Number(beforeUser!.virtualBalance);

      // First claim
      const result1 =
        await DailyLoginService.claimDailyReward(serviceTestUserId);
      expect(result1.success).toBe(true);
      expect(result1.streak).toBe(1);

      // Second claim immediately after (should fail)
      const result2 =
        await DailyLoginService.claimDailyReward(serviceTestUserId);
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('Cannot claim yet');

      // Verify only one reward was given
      const afterUser = await getUserStreak(serviceTestUserId);
      expect(afterUser!.dailyLoginStreak).toBe(1);
      expect(Number(afterUser!.virtualBalance)).toBe(
        balanceBefore + POINTS.DAILY_LOGIN_DAY_1
      );
    });
  });

  describe('claimDailyReward - Invalid User', () => {
    test('returns error for invalid userId format', async () => {
      if (skipIfNoDb()) return;

      const result = await DailyLoginService.claimDailyReward('invalid-format');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid userId format');
    });

    test('returns error for non-existent valid userId', async () => {
      if (skipIfNoDb()) return;

      const result =
        await DailyLoginService.claimDailyReward('123456789012345678');

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });
  });
});

// ─── Concurrency Tests ───────────────────────────────────────────────────────

describe('Daily Login - Concurrency', () => {
  let concurrencyTestUserId: string | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();
    if (dbAvailable) {
      concurrencyTestUserId = await createTestUser();
    }
  });

  afterAll(async () => {
    if (dbAvailable && concurrencyTestUserId) {
      await deleteTestUser(concurrencyTestUserId);
    }
  });

  test('concurrent reads are consistent', async () => {
    if (skipIfNoDb() || !concurrencyTestUserId) return;

    await setUserStreak(concurrencyTestUserId, 7, new Date());

    // Perform 10 concurrent reads
    const reads = Array.from({ length: 10 }, () =>
      getUserStreak(concurrencyTestUserId!)
    );

    const results = await Promise.all(reads);

    // All reads should return the same value
    for (const result of results) {
      expect(result!.dailyLoginStreak).toBe(7);
    }
  });

  test('database handles rapid updates', async () => {
    if (skipIfNoDb() || !concurrencyTestUserId) return;

    // Execute rapid sequential updates
    for (let i = 1; i <= 5; i++) {
      await db
        .update(users)
        .set({ dailyLoginStreak: i })
        .where(eq(users.id, concurrencyTestUserId));
    }

    const user = await getUserStreak(concurrencyTestUserId);
    expect(user!.dailyLoginStreak).toBe(5);
  });
});

// ─── Error Handling Tests ────────────────────────────────────────────────────

describe('Daily Login - Error Handling', () => {
  test('non-existent user returns undefined from DB query', async () => {
    if (skipIfNoDb()) return;

    const fakeUserId = 'non-existent-user-12345';
    const user = await getUserStreak(fakeUserId);
    expect(user).toBeUndefined();
  });

  test('service clamps negative streak values to zero', async () => {
    if (skipIfNoDb()) return;

    const tempUserId = await createTestUser();

    try {
      await db
        .update(users)
        .set({ dailyLoginStreak: -1 })
        .where(eq(users.id, tempUserId))
        .execute();

      const streakInfo = await DailyLoginService.getStreakInfo(tempUserId);
      expect(streakInfo.currentStreak).toBe(0);
      expect(streakInfo.nextReward).toBe(POINTS.DAILY_LOGIN_DAY_1);
    } finally {
      await deleteTestUser(tempUserId);
    }
  });
});

// ─── Output Verification ─────────────────────────────────────────────────────

describe('Daily Login - Output Verification', () => {
  test('reward values match constants', () => {
    expect(POINTS.DAILY_LOGIN_DAY_1).toBe(50);
    expect(POINTS.DAILY_LOGIN_DAY_7).toBe(200);
    expect(POINTS.DAILY_LOGIN_MILESTONE_7D).toBe(500);
    expect(POINTS.DAILY_LOGIN_MILESTONE_90D).toBe(5000);
  });

  test('cumulative week 1 rewards are exactly 1375', () => {
    let total = 0;
    for (let i = 1; i <= 7; i++) {
      const key = `DAILY_LOGIN_DAY_${i}` as keyof typeof POINTS;
      total += POINTS[key];
    }
    total += POINTS.DAILY_LOGIN_MILESTONE_7D;
    expect(total).toBe(1375);
  });

  test('all milestone values', () => {
    expect(POINTS.DAILY_LOGIN_MILESTONE_7D).toBe(500);
    expect(POINTS.DAILY_LOGIN_MILESTONE_14D).toBe(750);
    expect(POINTS.DAILY_LOGIN_MILESTONE_30D).toBe(1500);
    expect(POINTS.DAILY_LOGIN_MILESTONE_60D).toBe(3000);
    expect(POINTS.DAILY_LOGIN_MILESTONE_90D).toBe(5000);
  });
});
