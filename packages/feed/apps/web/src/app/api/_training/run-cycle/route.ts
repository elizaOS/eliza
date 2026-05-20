/**
 * Internal Training Cycle API
 *
 * @route GET /api/_training/run-cycle - Get training cycle status
 * @route POST /api/_training/run-cycle - Run training cycle (disabled)
 * @access Internal
 *
 * @description
 * Internal training endpoint. Training functionality is handled by separate
 * Eliza agent processes. This endpoint is kept for future integration.
 *
 * @openapi
 * /api/_training/run-cycle:
 *   get:
 *     tags:
 *       - Training
 *     summary: Get internal training cycle status
 *     description: Returns training automation status (currently disabled)
 *     responses:
 *       200:
 *         description: Status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *   post:
 *     tags:
 *       - Training
 *     summary: Run internal training cycle (disabled)
 *     description: Manual training cycles are currently disabled
 *     responses:
 *       200:
 *         description: Training cycle disabled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 */

import { withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import { NextResponse } from 'next/server';

export const POST = withErrorHandling(async function POST() {
  logger.info('Training cycle endpoint called (currently disabled)');

  return NextResponse.json({
    success: false,
    message: 'Manual training cycles are currently disabled',
    hint: 'Training is handled by separate Eliza agent processes',
  });
});

export const GET = withErrorHandling(async function GET() {
  return NextResponse.json({
    enabled: false,
    message: 'Training automation is currently disabled',
    hint: 'Training is handled by separate Eliza agent processes',
  });
});
