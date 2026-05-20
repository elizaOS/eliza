/**
 * Weekly Dataset Upload Cron API
 *
 * @route POST /api/cron/weekly-dataset-upload - Weekly dataset upload
 * @access Cron (CRON_SECRET)
 *
 * @description
 * Automated weekly job that aggregates benchmark data, uploads dataset to
 * HuggingFace, benchmarks RL models, and uploads improved models. Runs
 * weekly on Sundays at 2 AM UTC.
 *
 * @openapi
 * /api/cron/weekly-dataset-upload:
 *   post:
 *     tags:
 *       - Cron
 *     summary: Weekly dataset upload
 *     description: Weekly job for dataset upload and model benchmarking
 *     security:
 *       - CronSecret: []
 *     responses:
 *       200:
 *         description: Upload completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 datasetsUploaded:
 *                   type: integer
 *                 modelsBenchmarked:
 *                   type: integer
 *       401:
 *         description: Unauthorized (invalid CRON_SECRET)
 *
 * @example
 * ```typescript
 * // Called by Vercel Cron (weekly)
 * await fetch('/api/cron/weekly-dataset-upload', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
 * });
 * ```
 */

import { verifyCronAuth, withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import { huggingFaceIntegration } from '@feed/training';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const POST = withErrorHandling(async function POST(
  request: NextRequest
) {
  // Security: Verify cron authorization (fail-closed in production)
  if (!verifyCronAuth(request, { jobName: 'WeeklyDatasetUpload' })) {
    logger.warn('Unauthorized cron request', undefined, 'WeeklyDatasetUpload');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  logger.info(
    'Starting weekly dataset upload job',
    undefined,
    'WeeklyDatasetUpload'
  );

  // Use the integrated service
  const result = await huggingFaceIntegration.executeWeeklyUpload();

  logger.info(
    'Weekly dataset upload job completed',
    {
      duration: result.duration,
      benchmarkDataset: result.datasets.benchmarks.success,
      trajectoryDataset: result.datasets.trajectories.success,
      modelsProcessed: result.models.processed,
      modelsBenchmarked: result.models.benchmarked,
      modelsUploaded: result.models.uploaded,
      errors: result.errors.length,
    },
    'WeeklyDatasetUpload'
  );

  return NextResponse.json({
    success: result.success,
    duration: result.duration,
    results: {
      benchmarkDataset: result.datasets.benchmarks,
      trajectoryDataset: result.datasets.trajectories,
      modelsProcessed: result.models.processed,
      modelsBenchmarked: result.models.benchmarked,
      modelsUploaded: result.models.uploaded,
      errors: result.errors,
    },
  });
});
