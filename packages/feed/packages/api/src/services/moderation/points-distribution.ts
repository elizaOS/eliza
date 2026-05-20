/**
 * Reputation Distribution Service
 *
 * @description Distributes forfeited account reputation to successful reporters
 * when content violations (CSAM/scammer) are confirmed. Handles reward
 * allocation based on report evaluation outcomes and ensures fair distribution
 * among valid reporters.
 */

import {
  and,
  asc,
  db,
  eq,
  gte,
  pointsTransactions,
  reports,
  users,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";

/**
 * ReputationService interface for dependency injection.
 *
 * @description Service interface injected from the web application layer to
 * avoid circular dependencies between packages.
 */
type ReputationServiceAdapter = {
  awardReputation: (
    userId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    reputationAwarded: number;
    newReputationTotal: number;
  }>;
};

// Service instance injected from the web application layer.
let reputationServiceInstance: ReputationServiceAdapter | null = null;

export function setReputationService(service: ReputationServiceAdapter): void {
  reputationServiceInstance = service;
}

function getReputationService(): ReputationServiceAdapter {
  if (!reputationServiceInstance) {
    throw new Error(
      "ReputationService not initialized. Call setReputationService() first.",
    );
  }
  return reputationServiceInstance;
}

/**
 * @deprecated Use setReputationService.
 */
export function setPointsService(service: {
  awardPoints: ReputationServiceAdapter["awardReputation"];
}): void {
  setReputationService({
    awardReputation: service.awardPoints,
  });
}

/**
 * Distribute forfeited reputation to successful reporters.
 *
 * When a user is confirmed as CSAM/scammer, distribute their reputation
 * proportionally to all users who successfully reported them.
 */
export async function distributeReputationToReporters(
  reportedUserId: string,
  reason: "scammer" | "csam",
): Promise<void> {
  logger.info(
    "Distributing reputation to successful reporters",
    {
      reportedUserId,
      reason,
    },
    "ReputationDistribution",
  );

  // Get the reported user's point balance
  const [reportedUser] = await db
    .select({
      id: users.id,
      reputationPoints: users.reputationPoints,
      earnedPoints: users.earnedPoints,
      invitePoints: users.invitePoints,
      bonusPoints: users.bonusPoints,
    })
    .from(users)
    .where(eq(users.id, reportedUserId))
    .limit(1);

  if (!reportedUser) {
    logger.warn(
      "Reported user not found",
      { reportedUserId },
      "ReputationDistribution",
    );
    return;
  }

  // Calculate forfeited reputation (all reputation except earned points).
  // We only forfeit bonus/invite reputation, not earned points.
  const forfeitedPoints = reportedUser.invitePoints + reportedUser.bonusPoints;

  if (forfeitedPoints <= 0) {
    logger.info(
      "No reputation to distribute",
      { reportedUserId, forfeitedPoints },
      "ReputationDistribution",
    );
    return;
  }

  // Find all successful reports for this user
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const successfulReports = await db
    .select({
      id: reports.id,
      reporterId: reports.reporterId,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(
      and(
        eq(reports.reportedUserId, reportedUserId),
        eq(reports.status, "resolved"),
        eq(reports.category, reason === "scammer" ? "spam" : "inappropriate"),
        gte(reports.createdAt, ninetyDaysAgo),
      ),
    )
    .orderBy(asc(reports.createdAt));

  if (successfulReports.length === 0) {
    logger.info(
      "No successful reports found",
      { reportedUserId },
      "ReputationDistribution",
    );
    // Still forfeit the points (remove them from the user)
    await forfeitUserPoints(reportedUserId, forfeitedPoints);
    return;
  }

  // Distribute reputation proportionally.
  // Each reporter gets an equal share.
  const pointsPerReporter = Math.floor(
    forfeitedPoints / successfulReports.length,
  );
  const remainder = forfeitedPoints % successfulReports.length;

  logger.info(
    "Distributing reputation",
    {
      reportedUserId,
      forfeitedPoints,
      successfulReportsCount: successfulReports.length,
      pointsPerReporter,
      remainder,
    },
    "ReputationDistribution",
  );

  const reputationService = getReputationService();

  // Distribute reputation to each reporter.
  const distributionResults = await Promise.allSettled(
    successfulReports.map(async (report, index) => {
      // First reporter gets the remainder if any
      const pointsToAward = pointsPerReporter + (index === 0 ? remainder : 0);

      if (pointsToAward <= 0) {
        return;
      }

      await reputationService.awardReputation(
        report.reporterId,
        pointsToAward,
        "report_reward",
        {
          reportedUserId,
          reportId: report.id,
          reason,
          forfeitedPoints: pointsToAward,
        },
      );

      logger.info(
        "Awarded reputation to reporter",
        {
          reporterId: report.reporterId,
          points: pointsToAward,
          reportId: report.id,
        },
        "ReputationDistribution",
      );
    }),
  );

  // Log any failures
  const failures = distributionResults.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    logger.error(
      "Failed to distribute reputation to some reporters",
      {
        reportedUserId,
        failures: failures.length,
        total: distributionResults.length,
      },
      "ReputationDistribution",
    );
  }

  // Forfeit the reputation from the reported user.
  await forfeitUserPoints(reportedUserId, forfeitedPoints);

  logger.info(
    "✅ Reputation distribution complete",
    {
      reportedUserId,
      forfeitedPoints,
      reportersRewarded: successfulReports.length,
      totalDistributed: forfeitedPoints,
    },
    "ReputationDistribution",
  );
}

/**
 * @deprecated Use distributeReputationToReporters.
 */
export const distributePointsToReporters = distributeReputationToReporters;

/**
 * Forfeit points from a user (remove bonus/invite points)
 */
async function forfeitUserPoints(
  userId: string,
  amount: number,
): Promise<void> {
  const [user] = await db
    .select({
      reputationPoints: users.reputationPoints,
      invitePoints: users.invitePoints,
      bonusPoints: users.bonusPoints,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return;
  }

  // Calculate how much to remove from each category
  const totalForfeitable = user.invitePoints + user.bonusPoints;
  if (totalForfeitable === 0) {
    return;
  }

  // Remove proportionally from invite and bonus points
  // Avoid division by zero
  const inviteRatio =
    totalForfeitable > 0 ? user.invitePoints / totalForfeitable : 0;
  const bonusRatio =
    totalForfeitable > 0 ? user.bonusPoints / totalForfeitable : 0;

  const inviteToRemove = Math.floor(amount * inviteRatio);
  const bonusToRemove = Math.floor(amount * bonusRatio);

  // Update user
  await db
    .update(users)
    .set({
      invitePoints: Math.max(0, user.invitePoints - inviteToRemove),
      bonusPoints: Math.max(0, user.bonusPoints - bonusToRemove),
      reputationPoints: Math.max(0, user.reputationPoints - amount),
    })
    .where(eq(users.id, userId));

  // Create transaction record
  await db.insert(pointsTransactions).values({
    id: await generateSnowflakeId(),
    userId,
    amount: -amount,
    pointsBefore: user.reputationPoints,
    pointsAfter: user.reputationPoints - amount,
    reason: "forfeited",
    metadata: JSON.stringify({
      reason: "csam_or_scammer_confirmed",
      forfeitedAmount: amount,
    }),
  });

  logger.info(
    "Forfeited points from user",
    {
      userId,
      amount,
      inviteRemoved: inviteToRemove,
      bonusRemoved: bonusToRemove,
    },
    "PointsDistribution",
  );
}

/**
 * Check if a user should have points distributed (CSAM/scammer confirmed)
 */
export async function shouldDistributePoints(userId: string): Promise<boolean> {
  const [user] = await db
    .select({
      isBanned: users.isBanned,
      isScammer: users.isScammer,
      isCSAM: users.isCSAM,
      invitePoints: users.invitePoints,
      bonusPoints: users.bonusPoints,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return false;
  }

  // Only distribute if user is banned AND marked as scammer or CSAM
  return user.isBanned && (user.isScammer || user.isCSAM);
}
