/**
 * Integration Tests: Referral Points System
 *
 * Tests the actual referral points flow using the database:
 * - Creating users with referral codes
 * - Awarding referral signup points to referrer
 * - Self-referral detection via IP hash
 * - Unqualified referral limit (10 max)
 * - Qualification when referred user links social account
 * - FIFO queue for pending referrals when slots open
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { getOrCreateReferralCode, PointsService } from '@babylon/api';
import {
  and,
  count,
  db,
  dbWrite,
  eq,
  isNull,
  pointsTransactions,
  referrals,
  users,
} from '@babylon/db';
import { generateSnowflakeId, POINTS } from '@babylon/shared';

// Test user IDs that we'll clean up
const testUserIds: string[] = [];
const testReferralIds: string[] = [];

async function createTestUser(
  overrides: Partial<typeof users.$inferInsert> = {}
) {
  const userId = await generateSnowflakeId();
  const username = `test-referral-${userId.slice(-8)}`;
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-${userId}`,
    username,
    displayName: username,
    profileComplete: true,
    reputationPoints: 1000,
    invitePoints: 0,
    earnedPoints: 0,
    bonusPoints: 0,
    referralCount: 0,
    updatedAt: now,
    ...overrides,
  });

  testUserIds.push(userId);
  return { userId, username };
}

async function cleanupTestData() {
  // Clean up referrals first (foreign key constraint)
  if (testReferralIds.length > 0) {
    for (const referralId of testReferralIds) {
      await db.delete(referrals).where(eq(referrals.id, referralId));
    }
  }

  // Clean up point transactions
  for (const userId of testUserIds) {
    await db
      .delete(pointsTransactions)
      .where(eq(pointsTransactions.userId, userId));
  }

  // Clean up users
  for (const userId of testUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }

  // Clear arrays
  testUserIds.length = 0;
  testReferralIds.length = 0;
}

describe('Referral Points Integration Tests', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('Basic Referral Flow', () => {
    it('should generate referral code using username', async () => {
      const { userId, username } = await createTestUser();

      const referralCode = await getOrCreateReferralCode(userId);

      expect(referralCode).toBe(username);

      // Verify it was saved to database
      const [user] = await dbWrite
        .select({ referralCode: users.referralCode })
        .from(users)
        .where(eq(users.id, userId));

      expect(user?.referralCode).toBe(username);
    });

    it('should award REFERRAL_SIGNUP points to referrer when new user signs up', async () => {
      // Create referrer
      const { userId: referrerId } = await createTestUser();

      // Create referred user with referrer set
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
      });

      // Get referrer's points before
      const [referrerBefore] = await db
        .select({
          reputationPoints: users.reputationPoints,
          invitePoints: users.invitePoints,
        })
        .from(users)
        .where(eq(users.id, referrerId));

      const pointsBefore = referrerBefore?.reputationPoints ?? 0;
      const invitePointsBefore = referrerBefore?.invitePoints ?? 0;

      // Award referral signup points
      const result = await PointsService.awardReferralSignup(
        referrerId,
        referredUserId
      );

      expect(result.success).toBe(true);
      expect(result.pointsAwarded).toBe(POINTS.REFERRAL_SIGNUP);
      expect(result.newTotal).toBe(pointsBefore + POINTS.REFERRAL_SIGNUP);

      // Verify invite points were incremented
      const [referrerAfter] = await db
        .select({
          reputationPoints: users.reputationPoints,
          invitePoints: users.invitePoints,
        })
        .from(users)
        .where(eq(users.id, referrerId));

      expect(referrerAfter?.invitePoints).toBe(
        invitePointsBefore + POINTS.REFERRAL_SIGNUP
      );
    });

    it('should award REFERRAL_BONUS points to new user who used referral code', async () => {
      // Create referrer and referred user
      const { userId: referrerId } = await createTestUser();
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
      });

      // Get referred user's points before
      const [referredBefore] = await db
        .select({
          reputationPoints: users.reputationPoints,
          bonusPoints: users.bonusPoints,
        })
        .from(users)
        .where(eq(users.id, referredUserId));

      const pointsBefore = referredBefore?.reputationPoints ?? 0;

      // Award referral bonus to new user
      const result = await PointsService.awardPoints(
        referredUserId,
        POINTS.REFERRAL_BONUS,
        'referral_bonus',
        { referrerId }
      );

      expect(result.success).toBe(true);
      expect(result.pointsAwarded).toBe(POINTS.REFERRAL_BONUS);
      expect(result.newTotal).toBe(pointsBefore + POINTS.REFERRAL_BONUS);
    });
  });

  describe('Self-Referral Detection', () => {
    it('should block self-referral within 15 minutes with same IP and no different identifiers', async () => {
      const sameIpHash = 'test-ip-hash-12345';
      const now = new Date();

      // Create referrer without unique identifiers (no privyId, wallet, farcaster, twitter)
      // This simulates a scenario where we can't distinguish users by identity
      const { userId: referrerId } = await createTestUser({
        registrationIpHash: sameIpHash,
        createdAt: now,
        privyId: null, // Remove unique identifier to test self-referral detection
        walletAddress: null,
        farcasterFid: null,
        twitterId: null,
      });

      // Create referred user with same IP, same lack of identifiers, created 5 minutes later
      const fiveMinutesLater = new Date(now.getTime() + 5 * 60 * 1000);
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
        registrationIpHash: sameIpHash,
        createdAt: fiveMinutesLater,
        privyId: null, // Remove unique identifier to test self-referral detection
        walletAddress: null,
        farcasterFid: null,
        twitterId: null,
      });

      // Try to award points - should be blocked because:
      // 1. Same IP
      // 2. Within 15 minutes
      // 3. No different identifiers (both have null for all identity fields)
      const result = await PointsService.awardReferralSignup(
        referrerId,
        referredUserId
      );

      expect(result.success).toBe(false);
      expect(result.pointsAwarded).toBe(0);
      expect(result.error).toContain('Self-referral detected');
    });

    it('should allow referral with same IP if users have different wallets', async () => {
      const sameIpHash = 'test-ip-hash-67890';
      const now = new Date();

      // Create referrer with wallet
      const { userId: referrerId } = await createTestUser({
        registrationIpHash: sameIpHash,
        createdAt: now,
        walletAddress: '0x1111111111111111111111111111111111111111',
      });

      // Create referred user with same IP but different wallet
      const fiveMinutesLater = new Date(now.getTime() + 5 * 60 * 1000);
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
        registrationIpHash: sameIpHash,
        createdAt: fiveMinutesLater,
        walletAddress: '0x2222222222222222222222222222222222222222',
      });

      // Award points - should succeed due to different wallets
      const result = await PointsService.awardReferralSignup(
        referrerId,
        referredUserId
      );

      expect(result.success).toBe(true);
      expect(result.pointsAwarded).toBe(POINTS.REFERRAL_SIGNUP);
    });

    it('should allow referral with different IPs regardless of timing', async () => {
      const now = new Date();

      // Create referrer with one IP
      const { userId: referrerId } = await createTestUser({
        registrationIpHash: 'ip-hash-referrer',
        createdAt: now,
      });

      // Create referred user with different IP, created 1 minute later
      const oneMinuteLater = new Date(now.getTime() + 1 * 60 * 1000);
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
        registrationIpHash: 'ip-hash-referred',
        createdAt: oneMinuteLater,
      });

      // Award points - should succeed
      const result = await PointsService.awardReferralSignup(
        referrerId,
        referredUserId
      );

      expect(result.success).toBe(true);
      expect(result.pointsAwarded).toBe(POINTS.REFERRAL_SIGNUP);
    });
  });

  describe('Unqualified Referral Limit', () => {
    it('should enforce limit of 10 unqualified referrals', async () => {
      // Create referrer
      const { userId: referrerId } = await createTestUser();

      // Create 10 referrals that count toward the limit
      for (let i = 0; i < 10; i++) {
        const { userId: referredUserId } = await createTestUser({
          referredBy: referrerId,
          registrationIpHash: `unique-ip-${i}`,
        });

        // Create referral record
        const referralId = await generateSnowflakeId();
        await db.insert(referrals).values({
          id: referralId,
          referrerId,
          referredUserId,
          referralCode: `code-${i}`,
          status: 'completed',
          signupPointsAwarded: true,
          completedAt: new Date(),
        });
        testReferralIds.push(referralId);
      }

      // Verify we have 10 unqualified referrals
      const [countResult] = await db
        .select({ count: count() })
        .from(referrals)
        .where(
          and(
            eq(referrals.referrerId, referrerId),
            eq(referrals.status, 'completed'),
            isNull(referrals.qualifiedAt),
            eq(referrals.signupPointsAwarded, true)
          )
        );

      expect(countResult?.count).toBe(10);

      // Create 11th referred user
      const { userId: eleventhUserId } = await createTestUser({
        referredBy: referrerId,
        registrationIpHash: 'unique-ip-11',
      });

      // Try to award points - should not award (limit reached)
      const result = await PointsService.awardReferralSignup(
        referrerId,
        eleventhUserId
      );

      // Points should be deferred (success=true but pointsAwarded=0)
      expect(result.success).toBe(true);
      expect(result.pointsAwarded).toBe(0);
    });
  });

  describe('Referral Qualification', () => {
    it('should qualify referral when referred user links social account', async () => {
      // Create referrer
      const { userId: referrerId } = await createTestUser();

      // Create referred user
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
        hasFarcaster: false,
        hasTwitter: false,
        walletAddress: null,
      });

      // Create referral record
      const referralId = await generateSnowflakeId();
      await db.insert(referrals).values({
        id: referralId,
        referrerId,
        referredUserId,
        referralCode: 'test-code',
        status: 'completed',
        signupPointsAwarded: true,
        completedAt: new Date(),
      });
      testReferralIds.push(referralId);

      // Simulate user linking Farcaster
      await db
        .update(users)
        .set({ hasFarcaster: true, farcasterFid: '12345' })
        .where(eq(users.id, referredUserId));

      // Get referrer's points before qualification
      const [referrerBefore] = await db
        .select({
          reputationPoints: users.reputationPoints,
        })
        .from(users)
        .where(eq(users.id, referrerId));

      const pointsBefore = referrerBefore?.reputationPoints ?? 0;

      // Check and qualify the referral
      const result =
        await PointsService.checkAndQualifyReferral(referredUserId);

      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect(result?.pointsAwarded).toBe(POINTS.REFERRAL_QUALIFIED);

      // Verify referral was marked as qualified
      const [referral] = await db
        .select({ qualifiedAt: referrals.qualifiedAt })
        .from(referrals)
        .where(eq(referrals.id, referralId));

      expect(referral?.qualifiedAt).not.toBeNull();

      // Verify referrer received bonus points
      const [referrerAfter] = await db
        .select({
          reputationPoints: users.reputationPoints,
        })
        .from(users)
        .where(eq(users.id, referrerId));

      expect(referrerAfter?.reputationPoints).toBe(
        pointsBefore + POINTS.REFERRAL_QUALIFIED
      );
    });

    it('should not qualify referral twice', async () => {
      // Create referrer and referred user with linked social
      const { userId: referrerId } = await createTestUser();
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
        hasFarcaster: true,
        farcasterFid: '12345',
      });

      // Create already-qualified referral record
      const referralId = await generateSnowflakeId();
      await db.insert(referrals).values({
        id: referralId,
        referrerId,
        referredUserId,
        referralCode: 'test-code',
        status: 'completed',
        signupPointsAwarded: true,
        qualifiedAt: new Date(), // Already qualified
        completedAt: new Date(),
      });
      testReferralIds.push(referralId);

      // Try to qualify again
      const result =
        await PointsService.checkAndQualifyReferral(referredUserId);

      // Should return null (already qualified)
      expect(result).toBeNull();
    });
  });

  describe('Points Tracking', () => {
    it('should create points transaction record for referral award', async () => {
      // Create referrer and referred user
      const { userId: referrerId } = await createTestUser();
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
        registrationIpHash: 'unique-ip-tracking',
      });

      // Award referral points
      await PointsService.awardReferralSignup(referrerId, referredUserId);

      // Check transaction was created
      const transactions = await db
        .select()
        .from(pointsTransactions)
        .where(
          and(
            eq(pointsTransactions.userId, referrerId),
            eq(pointsTransactions.reason, 'referral_signup')
          )
        );

      expect(transactions.length).toBeGreaterThan(0);

      const transaction = transactions[0];
      expect(transaction?.amount).toBe(POINTS.REFERRAL_SIGNUP);
      expect(transaction?.reason).toBe('referral_signup');
    });

    it('should increment referralCount on user record', async () => {
      // Create referrer
      const { userId: referrerId } = await createTestUser();

      // Get initial referral count
      const [userBefore] = await db
        .select({ referralCount: users.referralCount })
        .from(users)
        .where(eq(users.id, referrerId));

      const countBefore = userBefore?.referralCount ?? 0;

      // Create referred user and award points
      const { userId: referredUserId } = await createTestUser({
        referredBy: referrerId,
        registrationIpHash: 'unique-ip-count',
      });

      await PointsService.awardReferralSignup(referrerId, referredUserId);

      // Check referral count was incremented
      const [userAfter] = await db
        .select({ referralCount: users.referralCount })
        .from(users)
        .where(eq(users.id, referrerId));

      expect(userAfter?.referralCount).toBe(countBefore + 1);
    });
  });
});
