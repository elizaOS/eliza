import {
  recordCronExecution,
  requireCronAuth,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { drainTradingFeeOutboxBatch } from '@/lib/services/trading-fee-outbox';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const handler = async (request: NextRequest) => {
  const startTime = new Date();

  requireCronAuth(request, { jobName: 'trading-fee-outbox' });

  const result = await drainTradingFeeOutboxBatch();

  logger.info(
    'Trading fee outbox drain completed',
    result,
    'TradingFeeOutboxCron'
  );

  const payload = {
    success: true,
    ...result,
    timestamp: Date.now(),
  };
  recordCronExecution('trading-fee-outbox', startTime, payload);
  return successResponse(payload);
};

export const GET = withErrorHandling(handler);
export const POST = withErrorHandling(handler);
