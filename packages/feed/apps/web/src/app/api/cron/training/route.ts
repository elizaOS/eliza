/**
 * Training Status Cron Job API
 *
 * @route GET /api/cron/training - Check training readiness
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Daily cron job that checks training system readiness, reports status, and logs
 * metrics. Training is triggered by GitHub Actions; this endpoint monitors readiness.
 * Max execution time: 60s.
 *
 * @openapi
 * /api/cron/training:
 *   get:
 *     tags:
 *       - Cron
 *     summary: Check training readiness
 *     description: Checks if system is ready for training and reports status (requires CRON_SECRET)
 *     security:
 *       - CronSecret: []
 *     responses:
 *       200:
 *         description: Training status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ready:
 *                   type: boolean
 *                 reason:
 *                   type: string
 *                   nullable: true
 *                 stats:
 *                   type: object
 *                 status:
 *                   type: object
 *       401:
 *         description: Invalid or missing CRON_SECRET
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/cron/training', {
 *   headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
 * });
 * const { ready, stats } = await response.json();
 * ```
 *
 * @see {@link /lib/training/AutomationPipeline} Automation pipeline
 */

import { withCronAuth, withErrorHandling } from "@feed/api";
import { logger } from "@feed/shared";
import { automationPipeline } from "@feed/training";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 1 minute

/**
 * Daily training status check and reporting
 */
async function handler(_request: NextRequest) {
  logger.info(
    "Checking training system status",
    undefined,
    "TrainingStatusCron",
  );

  // 1. Check if ready to train
  const readiness = await automationPipeline.checkTrainingReadiness();

  // 2. Get overall system status
  const status = await automationPipeline.getStatus();

  // 3. Log readiness status
  if (readiness.ready) {
    logger.info(
      "✅ System ready for training",
      {
        trajectories: readiness.stats.totalTrajectories,
        scenarioGroups: readiness.stats.scenarioGroups,
        dataQuality: readiness.stats.dataQuality,
      },
      "TrainingStatusCron",
    );
  } else {
    logger.info(
      "⏳ System not ready for training",
      {
        reason: readiness.reason,
        stats: readiness.stats,
      },
      "TrainingStatusCron",
    );
  }

  // 4. Log recent activity
  logger.info(
    "Training system metrics",
    {
      dataCollection: status.dataCollection,
      latestModel: status.models.latest,
      deployedModels: status.models.deployed,
      lastTraining: status.training.lastCompleted,
    },
    "TrainingStatusCron",
  );

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    readiness,
    status,
    message: readiness.ready
      ? "✅ Ready for training - will run via GitHub Actions at 2 AM UTC"
      : `⏳ Not ready: ${readiness.reason}`,
  });
}

export const GET = withErrorHandling(
  withCronAuth("TrainingStatusCron", handler),
);
