/**
 * Integration Tests: WaitlistService
 *
 * Tests core waitlist service methods against a real database.
 * Requires PostgreSQL to be running.
 *
 * In CI: Database is automatically available via GitHub Actions services
 * Locally: Run `docker-compose up postgres` or have PostgreSQL running
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { WaitlistService } from "@feed/api";
import {
  db,
  eq,
  inArray,
  pointsTransactions,
  referrals,
  users,
} from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";

// Skip tests if DATABASE_URL is not set
const shouldSkip = !process.env.DATABASE_URL;
const describeWaitlist = shouldSkip ? describe.skip : describe;

describeWaitlist("WaitlistService", () => {
  // Test data cleanup
  const testUserIds: string[] = [];
  let dbAvailable = true;

  beforeAll(async () => {
    // Verify database connectivity before running tests
    await db.select().from(users).limit(1);
    dbAvailable = true;
  });

  beforeEach(() => {
    if (!dbAvailable) {
      throw new Error("Database not available - skipping test");
    }
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    // Clean up test users and related data
    if (testUserIds.length > 0) {
      // Delete referrals first (foreign key constraint)
      await db
        .delete(referrals)
        .where(inArray(referrals.referrerId, testUserIds));
      await db
        .delete(referrals)
        .where(inArray(referrals.referredUserId, testUserIds));

      // Delete points transactions
      await db
        .delete(pointsTransactions)
        .where(inArray(pointsTransactions.userId, testUserIds));

      // Delete test users
      await db.delete(users).where(inArray(users.id, testUserIds));

      testUserIds.length = 0;
    }
  });

  describe("generateInviteCode", () => {
    it("should generate unique 8-character uppercase code", () => {
      // Generate multiple codes to test uniqueness
      const codes = Array.from({ length: 10 }, () =>
        WaitlistService.generateInviteCode(),
      );

      // All should be 8 characters
      codes.forEach((code) => {
        expect(code).toHaveLength(8);
        expect(code).toMatch(/^[A-Z0-9_-]{8}$/);
      });

      // At least some should be unique (nanoid has tiny collision probability)
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBeGreaterThan(1);
    });
  });

  describe("markAsWaitlisted", () => {
    it("should mark an existing user as waitlisted", async () => {
      // Create a test user first
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-privy-${Date.now()}`,
        username: `testuser${Date.now()}`,
        displayName: "Test User",
        reputationPoints: 100,
        profileComplete: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      // Mark as waitlisted
      const result = await WaitlistService.markAsWaitlisted(userId);

      expect(result.success).toBe(true);
      expect(result.waitlistPosition).toBeGreaterThan(0);
      expect(result.inviteCode).toHaveLength(8);
      expect(result.points).toBe(100);

      // Verify in database
      const [updatedUser] = await db
        .select({
          isWaitlistActive: users.isWaitlistActive,
          waitlistPosition: users.waitlistPosition,
          referralCode: users.referralCode,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      expect(updatedUser?.isWaitlistActive).toBe(true);
      expect(updatedUser?.waitlistPosition).toBeGreaterThan(0);
      expect(updatedUser?.referralCode).toBeTruthy();
    });

    it("should prevent self-referral", async () => {
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-privy-${Date.now()}`,
        username: `testuser${Date.now()}`,
        displayName: "Test User",
        reputationPoints: 100,
        profileComplete: true,
        referralCode: "SELFREF1",
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      // Try to use own referral code
      const result = await WaitlistService.markAsWaitlisted(userId, "SELFREF1");

      expect(result.success).toBe(true);
      expect(result.referrerRewarded).toBe(false); // Should not reward self

      // Verify no invite points awarded
      const [updatedUser] = await db
        .select({ invitePoints: users.invitePoints })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      expect(updatedUser?.invitePoints).toBe(0);
    });

    it("should prevent double-referral", async () => {
      // Create referrer
      const referrerId = await generateSnowflakeId();
      await db.insert(users).values({
        id: referrerId,
        privyId: `test-privy-ref-${Date.now()}`,
        username: `referrer${Date.now()}`,
        displayName: "Referrer",
        reputationPoints: 100,
        profileComplete: true,
        referralCode: "REF12345",
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(referrerId);

      // Create user already referred by someone else
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-privy-${Date.now()}`,
        username: `testuser${Date.now()}`,
        displayName: "Test User",
        reputationPoints: 100,
        profileComplete: true,
        referredBy: "someone-else-id",
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      // Try to refer again with different code
      const result = await WaitlistService.markAsWaitlisted(userId, "REF12345");

      expect(result.success).toBe(true);
      expect(result.referrerRewarded).toBe(false); // Should not reward (already referred)

      // Referrer should not get points
      const [updatedReferrer] = await db
        .select({
          invitePoints: users.invitePoints,
          referralCount: users.referralCount,
        })
        .from(users)
        .where(eq(users.id, referrerId))
        .limit(1);

      expect(updatedReferrer?.invitePoints).toBe(0);
      expect(updatedReferrer?.referralCount).toBe(0);
    });

    it("should award +100 points to referrer on valid referral", async () => {
      // Create referrer
      const referrerId = await generateSnowflakeId();
      await db.insert(users).values({
        id: referrerId,
        privyId: `test-privy-ref-${Date.now()}`,
        username: `referrer${Date.now()}`,
        displayName: "Referrer",
        reputationPoints: 100,
        profileComplete: true,
        referralCode: "VALIDREF",
        isWaitlistActive: true,
        waitlistPosition: 1,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(referrerId);

      // Create new user
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-privy-${Date.now()}`,
        username: `testuser${Date.now()}`,
        displayName: "Test User",
        reputationPoints: 100,
        profileComplete: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      // Mark as waitlisted with referral code
      const result = await WaitlistService.markAsWaitlisted(userId, "VALIDREF");

      expect(result.success).toBe(true);
      expect(result.referrerRewarded).toBe(true);

      // Verify referrer got points (REFERRAL_SIGNUP is 100 points)
      const [updatedReferrer] = await db
        .select({
          invitePoints: users.invitePoints,
          reputationPoints: users.reputationPoints,
          referralCount: users.referralCount,
        })
        .from(users)
        .where(eq(users.id, referrerId))
        .limit(1);

      expect(updatedReferrer?.invitePoints).toBe(100); // REFERRAL_SIGNUP is 100 points
      expect(updatedReferrer?.reputationPoints).toBe(200); // 100 + 100
      expect(updatedReferrer?.referralCount).toBe(1);
    });
  });

  describe("getWaitlistPosition", () => {
    it("should calculate dynamic leaderboard rank based on invite points", async () => {
      // Create users with different invite points
      const userAId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userAId,
        privyId: `test-a-${Date.now()}`,
        username: `usera${Date.now()}`,
        displayName: "User A",
        reputationPoints: 100,
        invitePoints: 0, // No invites
        isWaitlistActive: true,
        waitlistPosition: 1,
        waitlistJoinedAt: new Date(Date.now() - 10000),
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userAId);

      const userBId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userBId,
        privyId: `test-b-${Date.now()}`,
        username: `userb${Date.now()}`,
        displayName: "User B",
        reputationPoints: 150,
        invitePoints: 50, // 1 invite
        isWaitlistActive: true,
        waitlistPosition: 2,
        waitlistJoinedAt: new Date(Date.now() - 5000),
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userBId);

      // Get positions
      const positionA = await WaitlistService.getWaitlistPosition(userAId);
      const positionB = await WaitlistService.getWaitlistPosition(userBId);

      // User B should rank higher than User A (more invite points)
      expect(positionB).not.toBeNull();
      expect(positionA).not.toBeNull();
      expect(positionB?.leaderboardRank).toBeLessThan(
        positionA?.leaderboardRank,
      );
      expect(positionB?.invitePoints).toBe(50);
      expect(positionA?.invitePoints).toBe(0);

      // Verify historical positions are different
      expect(positionA?.waitlistPosition).toBe(1);
      expect(positionB?.waitlistPosition).toBe(2);
    });

    it("should handle tie-breaking by signup date", async () => {
      const now = Date.now();

      // Create two users with same invite points
      const user1Id = await generateSnowflakeId();
      await db.insert(users).values({
        id: user1Id,
        privyId: `test-1-${now}`,
        username: `user1${now}`,
        displayName: "User 1",
        invitePoints: 100,
        isWaitlistActive: true,
        waitlistPosition: 1,
        waitlistJoinedAt: new Date(now - 10000), // Earlier
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(user1Id);

      const user2Id = await generateSnowflakeId();
      await db.insert(users).values({
        id: user2Id,
        privyId: `test-2-${now}`,
        username: `user2${now}`,
        displayName: "User 2",
        invitePoints: 100, // Same points
        isWaitlistActive: true,
        waitlistPosition: 2,
        waitlistJoinedAt: new Date(now - 5000), // Later
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(user2Id);

      const position1 = await WaitlistService.getWaitlistPosition(user1Id);
      const position2 = await WaitlistService.getWaitlistPosition(user2Id);

      // User 1 should rank higher than User 2 (joined earlier with same points)
      expect(position1).not.toBeNull();
      expect(position2).not.toBeNull();
      expect(position1?.leaderboardRank).toBeLessThan(
        position2?.leaderboardRank,
      );
      expect(position1?.invitePoints).toBe(position2?.invitePoints); // Same points
    });

    it("should calculate percentile correctly", async () => {
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-perc-${Date.now()}`,
        username: `userperc${Date.now()}`,
        displayName: "User Percentile",
        invitePoints: 100,
        isWaitlistActive: true,
        waitlistPosition: 1,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      const position = await WaitlistService.getWaitlistPosition(userId);

      expect(position?.percentile).toBeGreaterThanOrEqual(0);
      expect(position?.percentile).toBeLessThanOrEqual(100);
      expect(position?.totalCount).toBeGreaterThan(0);
    });
  });

  describe("bonuses", () => {
    it("should award wallet bonus only once", async () => {
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-wallet-${Date.now()}`,
        username: `userwallet${Date.now()}`,
        displayName: "Test Wallet User",
        reputationPoints: 100,
        bonusPoints: 0,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      // Award first time
      const awarded1 = await WaitlistService.awardWalletBonus(userId, "0x1234");
      expect(awarded1).toBe(true);

      // Try to award again
      const awarded2 = await WaitlistService.awardWalletBonus(userId, "0x5678");
      expect(awarded2).toBe(false); // Should not award twice

      // Verify only 300 points awarded (wallet bonus amount)
      const [updatedUser] = await db
        .select({
          bonusPoints: users.bonusPoints,
          reputationPoints: users.reputationPoints,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      expect(updatedUser?.bonusPoints).toBe(300);
      expect(updatedUser?.reputationPoints).toBe(400);
    });

    it("should award email bonus and save email to user record", async () => {
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-email-${Date.now()}`,
        username: `useremail${Date.now()}`,
        displayName: "Test Email User",
        reputationPoints: 100,
        bonusPoints: 0,
        isWaitlistActive: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      const testEmail = `test-${Date.now()}@example.com`;
      const awarded = await WaitlistService.awardEmailBonus(userId, testEmail);
      expect(awarded).toBe(true);

      const [updatedUser] = await db
        .select({
          email: users.email,
          bonusPoints: users.bonusPoints,
          reputationPoints: users.reputationPoints,
          pointsAwardedForEmail: users.pointsAwardedForEmail,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      expect(updatedUser?.email).toBe(testEmail);
      expect(updatedUser?.pointsAwardedForEmail).toBe(true);
      expect(updatedUser?.bonusPoints).toBe(100); // EMAIL_SUBMIT = 100
      expect(updatedUser?.reputationPoints).toBe(200); // 100 base + 100 bonus
    });

    it("should award email bonus only once", async () => {
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-email2-${Date.now()}`,
        username: `useremail2${Date.now()}`,
        displayName: "Test Email User 2",
        reputationPoints: 100,
        bonusPoints: 0,
        isWaitlistActive: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      const firstEmail = `first-${Date.now()}@example.com`;
      const awarded1 = await WaitlistService.awardEmailBonus(
        userId,
        firstEmail,
      );
      expect(awarded1).toBe(true);

      // Second attempt with a different email should be rejected
      const secondEmail = `second-${Date.now()}@example.com`;
      const awarded2 = await WaitlistService.awardEmailBonus(
        userId,
        secondEmail,
      );
      expect(awarded2).toBe(false);

      // Points should only be 100, not 200
      const [updatedUser] = await db
        .select({
          email: users.email,
          bonusPoints: users.bonusPoints,
          reputationPoints: users.reputationPoints,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      expect(updatedUser?.email).toBe(firstEmail); // First email retained
      expect(updatedUser?.bonusPoints).toBe(100);
      expect(updatedUser?.reputationPoints).toBe(200);
    });

    it("should create a points transaction for email bonus", async () => {
      const userId = await generateSnowflakeId();
      await db.insert(users).values({
        id: userId,
        privyId: `test-email3-${Date.now()}`,
        username: `useremail3${Date.now()}`,
        displayName: "Test Email User 3",
        reputationPoints: 50,
        bonusPoints: 0,
        isWaitlistActive: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(userId);

      const testEmail = `txn-${Date.now()}@example.com`;
      await WaitlistService.awardEmailBonus(userId, testEmail);

      const [txn] = await db
        .select()
        .from(pointsTransactions)
        .where(eq(pointsTransactions.userId, userId))
        .limit(1);

      expect(txn).toBeDefined();
      expect(txn?.amount).toBe(100); // EMAIL_SUBMIT = 100
      expect(txn?.reason).toBe("email_submit");
      expect(txn?.pointsBefore).toBe(50);
      expect(txn?.pointsAfter).toBe(150);
    });

    it("should return false for unknown user", async () => {
      const awarded = await WaitlistService.awardEmailBonus(
        "nonexistent-user-id",
        "test@example.com",
      );
      expect(awarded).toBe(false);
    });
  });

  describe("getTopWaitlistUsers", () => {
    it("should return users sorted by invite points", async () => {
      const timestamp = Date.now();

      // Create users with different invite points
      const user1Id = await generateSnowflakeId();
      await db.insert(users).values({
        id: user1Id,
        privyId: `test-top1-${timestamp}`,
        username: `top1${timestamp}`,
        displayName: "Top 1",
        invitePoints: 150, // Most invites
        isWaitlistActive: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(user1Id);

      const user2Id = await generateSnowflakeId();
      await db.insert(users).values({
        id: user2Id,
        privyId: `test-top2-${timestamp}`,
        username: `top2${timestamp}`,
        displayName: "Top 2",
        invitePoints: 100,
        isWaitlistActive: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(user2Id);

      const user3Id = await generateSnowflakeId();
      await db.insert(users).values({
        id: user3Id,
        privyId: `test-top3-${timestamp}`,
        username: `top3${timestamp}`,
        displayName: "Top 3",
        invitePoints: 50,
        isWaitlistActive: true,
        isTest: true,
        updatedAt: new Date(),
      });
      testUserIds.push(user3Id);

      const topUsers = await WaitlistService.getTopWaitlistUsers(100);

      expect(topUsers.length).toBeGreaterThanOrEqual(3);

      // Verify sorting is correct (descending by invite points)
      for (let i = 0; i < topUsers.length - 1; i++) {
        expect(topUsers[i]?.invitePoints).toBeGreaterThanOrEqual(
          topUsers[i + 1]?.invitePoints,
        );
      }

      // Find our test users and verify their relative ordering
      const testUser150 = topUsers.find(
        (u) => u.invitePoints === 150 && testUserIds.includes(u.id),
      );
      const testUser100 = topUsers.find(
        (u) => u.invitePoints === 100 && testUserIds.includes(u.id),
      );
      const testUser50 = topUsers.find(
        (u) => u.invitePoints === 50 && testUserIds.includes(u.id),
      );

      if (testUser150 && testUser100) {
        expect(testUser150.rank).toBeLessThan(testUser100.rank);
      }
      if (testUser100 && testUser50) {
        expect(testUser100.rank).toBeLessThan(testUser50.rank);
      }
    });
  });
});
