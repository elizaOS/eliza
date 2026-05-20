/**
 * Cron Metrics Dashboard API
 *
 * @route GET /api/admin/cron-metrics - Get cron job metrics
 * @access Admin
 *
 * @description
 * Returns metrics and alerts for all cron jobs. Used for monitoring
 * dashboards and operational visibility.
 *
 * @returns Dashboard metrics with job stats, summary, and active alerts
 */

import {
  cronMetrics,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/cron-metrics
 *
 * Returns cron job metrics dashboard data including:
 * - Individual job statistics
 * - Summary metrics
 * - Active alerts
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  // Verify admin authorization
  await requireAdmin(request);

  const dashboard = cronMetrics.getDashboardMetrics();

  return successResponse({
    success: true,
    timestamp: new Date().toISOString(),
    ...dashboard,
  });
});
