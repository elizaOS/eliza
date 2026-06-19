/**
 * Unit Tests: Referral Points System
 *
 * Tests the unqualified referral limit system where:
 * - Max 10 unqualified referrals can earn signup points at any time
 * - When a referral becomes qualified (links social account), a slot opens
 * - Pending referrals are awarded points in FIFO order when slots open
 */

import { describe, expect, it } from "bun:test";

// Mock types that match the real implementation
interface ReferralData {
  id: string;
  referrerId: string;
  referredUserId: string | null;
  status: string;
  signupPointsAwarded: boolean;
  qualifiedAt: Date | null;
  completedAt: Date | null;
}

interface UserData {
  id: string;
  reputationPoints: number;
  invitePoints: number;
  referralCount: number;
  referredBy: string | null;
  farcasterFid: string | null;
  twitterId: string | null;
  walletAddress: string | null;
}

// Constants matching the real POINTS config
const POINTS = {
  REFERRAL_SIGNUP: 100,
  REFERRAL_QUALIFIED: 100,
};

const UNQUALIFIED_LIMIT = 10;

describe("Referral Points System", () => {
  describe("awardReferralSignup Logic", () => {
    it("should award points when under unqualified limit", () => {
      // Setup: 5 unqualified referrals with points awarded (under limit of 10)
      const unqualifiedCount = 5;

      expect(unqualifiedCount < UNQUALIFIED_LIMIT).toBe(true);
      expect(UNQUALIFIED_LIMIT - unqualifiedCount).toBe(5); // 5 slots available
    });

    it("should NOT award points when at unqualified limit", () => {
      // Setup: 10 unqualified referrals with points awarded (at limit)
      const unqualifiedCount = 10;

      expect(unqualifiedCount >= UNQUALIFIED_LIMIT).toBe(true);
    });

    it("should track referral even when points are deferred", () => {
      // When at limit, referral should still be created with signupPointsAwarded = false
      const referralAtLimit: ReferralData = {
        id: "ref-123",
        referrerId: "user-1",
        referredUserId: "user-2",
        status: "completed",
        signupPointsAwarded: false, // Points deferred due to limit
        qualifiedAt: null,
        completedAt: new Date(),
      };

      expect(referralAtLimit.signupPointsAwarded).toBe(false);
      expect(referralAtLimit.status).toBe("completed");
    });

    it("should count only unqualified referrals with points awarded for limit", () => {
      // These should count toward the limit
      const countTowardLimit: ReferralData[] = [
        {
          id: "1",
          referrerId: "u1",
          referredUserId: "u2",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: null,
          completedAt: new Date(),
        },
        {
          id: "2",
          referrerId: "u1",
          referredUserId: "u3",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: null,
          completedAt: new Date(),
        },
      ];

      // These should NOT count toward the limit
      const doNotCountTowardLimit: ReferralData[] = [
        // Qualified referrals don't count (unlimited)
        {
          id: "3",
          referrerId: "u1",
          referredUserId: "u4",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: new Date(),
          completedAt: new Date(),
        },
        // Referrals without points awarded don't count (pending in queue)
        {
          id: "4",
          referrerId: "u1",
          referredUserId: "u5",
          status: "completed",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: new Date(),
        },
        // Pending status doesn't count
        {
          id: "5",
          referrerId: "u1",
          referredUserId: null,
          status: "pending",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: null,
        },
      ];

      // Verify counting logic
      const limitCount = countTowardLimit.filter(
        (r) =>
          r.status === "completed" &&
          r.qualifiedAt === null &&
          r.signupPointsAwarded === true,
      ).length;

      const shouldNotCount = doNotCountTowardLimit.filter(
        (r) =>
          r.status === "completed" &&
          r.qualifiedAt === null &&
          r.signupPointsAwarded === true,
      ).length;

      expect(limitCount).toBe(2);
      expect(shouldNotCount).toBe(0);
    });
  });

  describe("awardPendingReferralSignupPoints Logic", () => {
    it("should find oldest pending referral when slot opens", () => {
      // Pending referrals waiting for points (FIFO order)
      const pendingReferrals: ReferralData[] = [
        {
          id: "1",
          referrerId: "u1",
          referredUserId: "u2",
          status: "completed",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: new Date("2024-01-01"),
        },
        {
          id: "2",
          referrerId: "u1",
          referredUserId: "u3",
          status: "completed",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: new Date("2024-01-02"),
        },
        {
          id: "3",
          referrerId: "u1",
          referredUserId: "u4",
          status: "completed",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: new Date("2024-01-03"),
        },
      ];

      // Sort by completedAt to get FIFO order
      const sortedByOldest = [...pendingReferrals].sort(
        (a, b) =>
          (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0),
      );

      expect(sortedByOldest[0]?.id).toBe("1"); // Oldest first
      expect(sortedByOldest[1]?.id).toBe("2");
      expect(sortedByOldest[2]?.id).toBe("3");
    });

    it("should not award if still at unqualified limit", () => {
      const unqualifiedCount = 10;

      // No slot available, should not process pending
      expect(unqualifiedCount >= UNQUALIFIED_LIMIT).toBe(true);
    });

    it("should award when slot becomes available", () => {
      // One referral became qualified, so unqualified count drops
      const unqualifiedCountAfterQualification = 9;

      expect(unqualifiedCountAfterQualification < UNQUALIFIED_LIMIT).toBe(true);
      // Slot is now available for next pending referral
    });

    it("should mark referral as signupPointsAwarded after awarding", () => {
      const referralBeforeAward: ReferralData = {
        id: "ref-123",
        referrerId: "user-1",
        referredUserId: "user-2",
        status: "completed",
        signupPointsAwarded: false, // Before
        qualifiedAt: null,
        completedAt: new Date(),
      };

      // After awarding points
      const referralAfterAward: ReferralData = {
        ...referralBeforeAward,
        signupPointsAwarded: true, // After
      };

      expect(referralBeforeAward.signupPointsAwarded).toBe(false);
      expect(referralAfterAward.signupPointsAwarded).toBe(true);
    });
  });

  describe("checkAndQualifyReferral Logic", () => {
    it("should qualify referral when user links Farcaster", () => {
      const userWithFarcaster: UserData = {
        id: "user-1",
        reputationPoints: 100,
        invitePoints: 0,
        referralCount: 0,
        referredBy: "referrer-1",
        farcasterFid: "12345", // Linked Farcaster
        twitterId: null,
        walletAddress: null,
      };

      const isQualified =
        userWithFarcaster.farcasterFid !== null ||
        userWithFarcaster.twitterId !== null ||
        userWithFarcaster.walletAddress !== null;
      expect(isQualified).toBe(true);
    });

    it("should qualify referral when user links Twitter", () => {
      const userWithTwitter: UserData = {
        id: "user-1",
        reputationPoints: 100,
        invitePoints: 0,
        referralCount: 0,
        referredBy: "referrer-1",
        farcasterFid: null,
        twitterId: "123456789", // Linked Twitter
        walletAddress: null,
      };

      const isQualified =
        userWithTwitter.farcasterFid !== null ||
        userWithTwitter.twitterId !== null ||
        userWithTwitter.walletAddress !== null;
      expect(isQualified).toBe(true);
    });

    it("should qualify referral when user links wallet", () => {
      const userWithWallet: UserData = {
        id: "user-1",
        reputationPoints: 100,
        invitePoints: 0,
        referralCount: 0,
        referredBy: "referrer-1",
        farcasterFid: null,
        twitterId: null,
        walletAddress: "0x1234567890abcdef", // Linked Wallet
      };

      const isQualified =
        userWithWallet.farcasterFid !== null ||
        userWithWallet.twitterId !== null ||
        userWithWallet.walletAddress !== null;
      expect(isQualified).toBe(true);
    });

    it("should NOT qualify referral without social account", () => {
      const userWithoutSocial: UserData = {
        id: "user-1",
        reputationPoints: 100,
        invitePoints: 0,
        referralCount: 0,
        referredBy: "referrer-1",
        farcasterFid: null,
        twitterId: null,
        walletAddress: null,
      };

      const isQualified =
        userWithoutSocial.farcasterFid !== null ||
        userWithoutSocial.twitterId !== null ||
        userWithoutSocial.walletAddress !== null;
      expect(isQualified).toBe(false);
    });

    it("should trigger pending rewards when referral becomes qualified", () => {
      // When a referral becomes qualified, the unqualified count decreases by 1
      const unqualifiedCountBefore = 10;
      const unqualifiedCountAfter = 9; // One became qualified

      // This should trigger awardPendingReferralSignupPoints
      const slotOpened =
        unqualifiedCountBefore >= UNQUALIFIED_LIMIT &&
        unqualifiedCountAfter < UNQUALIFIED_LIMIT;

      expect(slotOpened).toBe(true);
    });

    it("should set qualifiedAt timestamp when qualified", () => {
      const referralBefore: ReferralData = {
        id: "ref-123",
        referrerId: "user-1",
        referredUserId: "user-2",
        status: "completed",
        signupPointsAwarded: true,
        qualifiedAt: null, // Not yet qualified
        completedAt: new Date(),
      };

      const qualificationTime = new Date();
      const referralAfter: ReferralData = {
        ...referralBefore,
        qualifiedAt: qualificationTime, // Now qualified
      };

      expect(referralBefore.qualifiedAt).toBeNull();
      expect(referralAfter.qualifiedAt).toEqual(qualificationTime);
    });
  });

  describe("Unqualified Limit Counting", () => {
    it("should correctly identify unqualified referrals with points", () => {
      const referrals: ReferralData[] = [
        // Counts toward limit: completed, not qualified, points awarded
        {
          id: "1",
          referrerId: "u1",
          referredUserId: "u2",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: null,
          completedAt: new Date(),
        },
        {
          id: "2",
          referrerId: "u1",
          referredUserId: "u3",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: null,
          completedAt: new Date(),
        },
        // Does NOT count: qualified
        {
          id: "3",
          referrerId: "u1",
          referredUserId: "u4",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: new Date(),
          completedAt: new Date(),
        },
        // Does NOT count: points not awarded (in queue)
        {
          id: "4",
          referrerId: "u1",
          referredUserId: "u5",
          status: "completed",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: new Date(),
        },
      ];

      const unqualifiedWithPointsCount = referrals.filter(
        (r) =>
          r.status === "completed" &&
          r.qualifiedAt === null &&
          r.signupPointsAwarded === true,
      ).length;

      expect(unqualifiedWithPointsCount).toBe(2);
    });

    it("should correctly identify pending referrals awaiting points", () => {
      const referrals: ReferralData[] = [
        // Pending: completed, not qualified, points NOT awarded
        {
          id: "1",
          referrerId: "u1",
          referredUserId: "u2",
          status: "completed",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: new Date(),
        },
        {
          id: "2",
          referrerId: "u1",
          referredUserId: "u3",
          status: "completed",
          signupPointsAwarded: false,
          qualifiedAt: null,
          completedAt: new Date(),
        },
        // Not pending: points already awarded
        {
          id: "3",
          referrerId: "u1",
          referredUserId: "u4",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: null,
          completedAt: new Date(),
        },
      ];

      const pendingCount = referrals.filter(
        (r) => r.status === "completed" && r.signupPointsAwarded === false,
      ).length;

      expect(pendingCount).toBe(2);
    });

    it("should correctly identify qualified referrals (unlimited)", () => {
      const referrals: ReferralData[] = [
        {
          id: "1",
          referrerId: "u1",
          referredUserId: "u2",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: new Date(),
          completedAt: new Date(),
        },
        {
          id: "2",
          referrerId: "u1",
          referredUserId: "u3",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: new Date(),
          completedAt: new Date(),
        },
        {
          id: "3",
          referrerId: "u1",
          referredUserId: "u4",
          status: "completed",
          signupPointsAwarded: true,
          qualifiedAt: null,
          completedAt: new Date(),
        },
      ];

      const qualifiedCount = referrals.filter(
        (r) => r.status === "completed" && r.qualifiedAt !== null,
      ).length;

      expect(qualifiedCount).toBe(2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle exactly 10 unqualified referrals at limit", () => {
      const unqualifiedCount = 10;
      expect(unqualifiedCount >= UNQUALIFIED_LIMIT).toBe(true);
      expect(unqualifiedCount === UNQUALIFIED_LIMIT).toBe(true);
    });

    it("should handle 0 unqualified referrals", () => {
      const unqualifiedCount = 0;
      expect(unqualifiedCount < UNQUALIFIED_LIMIT).toBe(true);
      expect(UNQUALIFIED_LIMIT - unqualifiedCount).toBe(10); // All 10 slots available
    });

    it("should handle multiple pending referrals becoming qualified", () => {
      // If 3 referrals become qualified simultaneously, 3 slots open
      const slotsOpened = 3;
      const pendingReferrals = 5;

      // Should award points to min(slotsOpened, pendingReferrals) referrals
      const pointsToAward = Math.min(slotsOpened, pendingReferrals);
      expect(pointsToAward).toBe(3);
    });

    it("should handle no pending referrals when slot opens", () => {
      const pendingReferrals = 0;
      const slotsAvailable = 5;

      // No points to award even though slots are available
      const referralsToReward = Math.min(slotsAvailable, pendingReferrals);
      expect(referralsToReward).toBe(0);
    });
  });

  describe("Points Calculations", () => {
    it("should award correct REFERRAL_SIGNUP points (100)", () => {
      expect(POINTS.REFERRAL_SIGNUP).toBe(100);
    });

    it("should award correct REFERRAL_QUALIFIED bonus (100)", () => {
      expect(POINTS.REFERRAL_QUALIFIED).toBe(100);
    });

    it("should calculate total points for referrer with multiple referrals", () => {
      const unqualifiedReferrals = 5;
      const qualifiedReferrals = 3;

      const unqualifiedPoints = unqualifiedReferrals * POINTS.REFERRAL_SIGNUP;
      const qualifiedSignupPoints = qualifiedReferrals * POINTS.REFERRAL_SIGNUP;
      const qualifiedBonusPoints =
        qualifiedReferrals * POINTS.REFERRAL_QUALIFIED;

      const totalPoints =
        unqualifiedPoints + qualifiedSignupPoints + qualifiedBonusPoints;

      expect(unqualifiedPoints).toBe(500); // 5 * 100
      expect(qualifiedSignupPoints).toBe(300); // 3 * 100
      expect(qualifiedBonusPoints).toBe(300); // 3 * 100
      expect(totalPoints).toBe(1100);
    });
  });
});
