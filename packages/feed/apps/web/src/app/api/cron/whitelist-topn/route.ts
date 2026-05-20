/**
 * Whitelist Top N Cron Job
 *
 * @route GET/POST /api/cron/whitelist-topn
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Runs daily at 00:00 UTC (via Vercel Cron) and permanently whitelists any
 * users in the current leaderboard Top N (category: all) who have never been
 * seen before.
 *
 * This implements: "reach Top N at any time => keep access".
 *
 * Important: revoked whitelist entries are never re-activated by this job.
 */

import {
  recordCronExecution,
  requireCronAuth,
  successResponse,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import { autoWhitelistCurrentTopN } from '@feed/api/services/whitelist-service';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (request: NextRequest) => {
  const startTime = new Date();
  requireCronAuth(request, { jobName: 'WhitelistTopNCron' });

  const result = await autoWhitelistCurrentTopN();

  recordCronExecution('whitelist-topn', startTime, {
    success: true,
    ...result,
  });

  return successResponse({
    success: true,
    ...result,
  });
});

// Vercel Cron uses GET; forward to POST after auth verification.
export const GET = withErrorHandling(async (request: NextRequest) => {
  if (
    !verifyCronAuth(request, {
      jobName: 'WhitelistTopNCron',
      allowVercelCronUserAgent: true,
    })
  ) {
    logger.warn(
      'Unauthorized GET request to cron endpoint',
      undefined,
      'WhitelistTopNCron'
    );
    return NextResponse.json(
      { error: 'Unauthorized cron request' },
      { status: 401 }
    );
  }

  return POST(request);
});
