/**
 * HuggingFace Integration Status API
 *
 * @route GET /api/huggingface/status - Get HuggingFace status
 * @access Public
 *
 * @description
 * Returns status and statistics for the HuggingFace integration system.
 * Useful for monitoring, debugging, and dashboard displays.
 *
 * @openapi
 * /api/huggingface/status:
 *   get:
 *     tags:
 *       - Integrations
 *     summary: Get HuggingFace status
 *     description: Returns HuggingFace integration status and statistics
 *     responses:
 *       200:
 *         description: Status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 statistics:
 *                   type: object
 *
 * @example
 * ```typescript
 * const status = await fetch('/api/huggingface/status')
 *   .then(r => r.json());
 * ```
 */

import { withErrorHandling } from "@feed/api";
import { logger } from "@feed/shared";
import { huggingFaceIntegration } from "@feed/training";
import { NextResponse } from "next/server";

export const GET = withErrorHandling(async function GET() {
  logger.info(
    "Fetching HuggingFace integration status",
    undefined,
    "HuggingFaceStatus",
  );

  // Get validation results
  const validation = await huggingFaceIntegration.validateSystemReadiness();

  // Get statistics
  const stats = await huggingFaceIntegration.getStatistics();

  // Check for new data
  const newData = await huggingFaceIntegration.hasNewDataToUpload();

  return NextResponse.json({
    status: "ok",
    ready: validation.ready,
    validation: {
      issues: validation.issues,
      warnings: validation.warnings,
    },
    statistics: stats,
    newDataAvailable: newData,
    environment: {
      hasToken: !!(process.env.HUGGING_FACE_TOKEN || process.env.HF_TOKEN),
      datasetName: process.env.HF_DATASET_NAME || "feedlabs/agent-benchmarks",
      trajectoryDatasetName:
        process.env.HF_TRAJECTORY_DATASET_NAME || "feedlabs/agent-trajectories",
      modelNamePrefix: process.env.HF_MODEL_NAME || "feedlabs/feed-agent",
    },
    nextScheduledRun: "Sundays at 2 AM UTC",
  });
});
