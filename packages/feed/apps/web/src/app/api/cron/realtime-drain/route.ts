import {
  drainOutboxBatch,
  requireCronAuth,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Security: Verify cron authorization
  requireCronAuth(request, { jobName: 'RealtimeDrain' });

  const result = await drainOutboxBatch();
  logger.info('Realtime outbox drain completed', result, 'Realtime');
  return successResponse({
    success: true,
    ...result,
    timestamp: Date.now(),
  });
});
