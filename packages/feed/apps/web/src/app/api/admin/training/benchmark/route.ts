/**
 * Admin Training Benchmark API
 *
 * @route POST /api/admin/training/benchmark - Benchmark model
 * @access Admin
 *
 * @description
 * Benchmarks a trained model and optionally compares with previous best model.
 * Returns performance metrics and comparison results.
 *
 * @openapi
 * /api/admin/training/benchmark:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Benchmark trained model
 *     description: Benchmarks model and compares with previous best (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - modelId
 *             properties:
 *               modelId:
 *                 type: string
 *               compare:
 *                 type: boolean
 *                 default: true
 *               threshold:
 *                 type: number
 *                 default: 0.95
 *     responses:
 *       200:
 *         description: Benchmark completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 results:
 *                   type: object
 *       400:
 *         description: Model ID required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/training/benchmark', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({ modelId: 'model-123' })
 * });
 * ```
 */

import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import { benchmarkService } from '@feed/training';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const maxDuration = 300; // 5 minutes for benchmarking

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const body = await request.json();
  const { modelId, compare = true, threshold = 0.95 } = body;

  if (!modelId) {
    return NextResponse.json({ error: 'Model ID required' }, { status: 400 });
  }

  logger.info('Starting model benchmark', { modelId }, 'BenchmarkAPI');

  // Run benchmark
  const benchmarkResults = await benchmarkService.benchmarkModel(modelId);

  // Compare if requested
  const comparison = compare
    ? await benchmarkService.compareModels(modelId, threshold)
    : null;

  logger.info(
    'Benchmark complete',
    { modelId, score: benchmarkResults.benchmarkScore },
    'BenchmarkAPI'
  );

  return successResponse({
    success: true,
    benchmark: benchmarkResults,
    comparison,
  });
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  // Get benchmark summary
  const summary = await benchmarkService.getBenchmarkSummary();

  return successResponse({
    success: true,
    summary,
  });
});
