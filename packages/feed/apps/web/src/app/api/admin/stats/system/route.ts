// GET /api/admin/stats/system - System health statistics

import {
  getSystemStatusSnapshot,
  requirePermission,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requirePermission(request, 'view_system');

  logger.info('System stats requested', {}, 'GET /api/admin/stats/system');

  const snapshot = await getSystemStatusSnapshot();

  return successResponse(snapshot);
});
