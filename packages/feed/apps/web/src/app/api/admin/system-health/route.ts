/**
 * Admin System Health API
 *
 * @route GET /api/admin/system-health - Get system health metrics
 * @access Admin
 *
 * @description
 * Compatibility endpoint for the admin dashboard. Uses the shared system
 * status snapshot so admin UI and alerting rely on the same health model.
 */

import {
  getSystemStatusSnapshot,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  logger.info(
    'System health check requested',
    {},
    'GET /api/admin/system-health'
  );

  const snapshot = await getSystemStatusSnapshot();
  const legacyStatus =
    snapshot.status === 'warning' ? 'degraded' : snapshot.status;

  return successResponse({
    ...snapshot,
    status: legacyStatus,
  });
});
