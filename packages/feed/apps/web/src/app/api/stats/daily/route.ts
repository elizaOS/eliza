import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { gameService } from '@feed/engine';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const [stats, engineStatus] = await Promise.all([
    gameService.getStats(),
    gameService.getStatus(),
  ]);

  const response = successResponse({
    success: true,
    date: new Date().toISOString().slice(0, 10),
    stats,
    engineStatus,
  });

  if (rateLimitInfo) addPublicReadHeaders(response, rateLimitInfo);
  return response;
});
