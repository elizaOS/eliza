/**
 * Health Check Cron Job API
 *
 * @route GET /api/cron/health-check - System health check
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Runs a shared observability snapshot used by the admin dashboard and sends
 * Discord alerts when the platform enters a critical state.
 */

import {
  getSystemStatusSnapshot,
  sendDiscordSystemAlertIfNeeded,
  withCronAuth,
  withErrorHandling,
} from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function handler(_request: NextRequest) {
  const startTime = Date.now();
  const snapshot = await getSystemStatusSnapshot();
  const duration = Date.now() - startTime;

  const databaseConnected = snapshot.health.database;
  const httpStatus = databaseConnected ? 200 : 500;

  const alertResult = await sendDiscordSystemAlertIfNeeded(snapshot);
  const logMethod =
    snapshot.status === 'critical'
      ? 'error'
      : snapshot.status === 'warning'
        ? 'warn'
        : 'info';

  logger[logMethod](
    'Health check completed',
    {
      duration,
      databaseConnected,
      systemStatus: snapshot.status,
      issues: snapshot.issues,
      discordAlert: alertResult.reason,
    },
    'HealthCheck'
  );

  return NextResponse.json(
    {
      success: databaseConnected,
      status: databaseConnected ? 'healthy' : 'unhealthy',
      database: databaseConnected ? 'connected' : 'error',
      duration,
      timestamp: snapshot.timestamp,
      systemStatus: snapshot.status,
      issues: snapshot.issues,
      criticalIssues: snapshot.criticalIssues,
      summary: snapshot.summary,
      alert: {
        sent: alertResult.sent,
        reason: alertResult.reason,
      },
    },
    { status: httpStatus }
  );
}

export const GET = withErrorHandling(withCronAuth('HealthCheck', handler));
