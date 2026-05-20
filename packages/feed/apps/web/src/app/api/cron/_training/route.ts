/**
 * Internal Training Cron API (Disabled)
 *
 * @route GET /api/cron/_training - Training cron (disabled)
 * @access Cron (CRON_SECRET)
 *
 * @description
 * Scheduled training cycle cron job. Currently disabled as training
 * functionality is handled by separate Eliza agent processes. Kept for
 * future integration.
 *
 * @openapi
 * /api/cron/_training:
 *   get:
 *     tags:
 *       - Cron
 *     summary: Training cron (disabled)
 *     description: Training cron job (currently disabled)
 *     security:
 *       - CronSecret: []
 *     responses:
 *       200:
 *         description: Cron executed (disabled status)
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
 *
 * @example
 * ```typescript
 * // Called by Vercel Cron
 * await fetch('/api/cron/_training', {
 *   headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
 * });
 * ```
 */

import { withCronAuth, withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

async function handler(_request: NextRequest) {
  logger.info('Training cron endpoint called (currently disabled)');

  return NextResponse.json({
    success: false,
    message: 'Training automation is currently disabled',
    hint: 'Training is handled by separate Eliza agent processes',
  });
}

export const GET = withErrorHandling(withCronAuth('TrainingCron', handler));
