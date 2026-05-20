import {
  getDeploymentEnvironment,
  recordCronExecution,
  relayCronToStaging,
  successResponse,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import { logger, type NotificationDigestSettings } from '@feed/shared';
import type { NextRequest } from 'next/server';
import {
  deliverDigestForUser,
  isDigestDue,
  listDigestCandidates,
} from '@/lib/services/notification-digest-service';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Determines whether this environment should process a given user.
 * When fan-out is active (both staging and production execute), each environment
 * processes a deterministic subset based on user ID hash to avoid double-processing.
 */
export function shouldProcessUser(userId: string, isFanOut: boolean): boolean {
  if (!isFanOut) {
    return true;
  }
  // Partition users by hashing their ID - production handles even, staging handles odd
  // This ensures deterministic, non-overlapping processing across environments
  const isProduction = getDeploymentEnvironment() === 'production';
  const hash = userId
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const isEvenHash = hash % 2 === 0;
  return isProduction ? isEvenHash : !isEvenHash;
}

const cronHandler = async (request: NextRequest) => {
  const startTime = new Date();

  if (!verifyCronAuth(request, { jobName: 'NotificationsDigest' })) {
    return successResponse({ error: 'Unauthorized' }, 401);
  }

  const relay = await relayCronToStaging(request, 'notifications-digest');
  const isRelayedDigestRequest =
    request.headers.get('x-cron-relay') === 'notifications-digest';
  const isFanOut = relay.forwarded || isRelayedDigestRequest;

  if (isFanOut) {
    // Note: Fan-out architecture — both environments execute after relay.
    // User partitioning via shouldProcessUser ensures no double-processing.
    if (process.env.SHARED_DATABASE_WITH_STAGING === 'true') {
      throw new Error(
        'Fan-out cron cannot run when SHARED_DATABASE_WITH_STAGING=true — would process users twice'
      );
    }
  }

  if (relay.forwarded) {
    logger.info(
      'Notifications digest cron relayed to staging (fan-out: also executing locally with user partitioning)',
      { status: relay.status, error: relay.error },
      'NotificationsDigestCron'
    );
  }

  const now = new Date();
  const candidates = await listDigestCandidates();
  let processed = 0;
  let delivered = 0;
  let withContent = 0;
  let failed = 0;
  let skippedPartition = 0;

  for (const candidate of candidates) {
    // Skip users assigned to other environment during fan-out
    if (!shouldProcessUser(candidate.id, isFanOut)) {
      skippedPartition += 1;
      continue;
    }

    const settings: NotificationDigestSettings = {
      digestEnabled: candidate.digestEnabled,
      frequency: candidate.digestFrequency,
      deliveryChannel: candidate.deliveryChannel,
    };

    if (
      !settings.digestEnabled ||
      !isDigestDue({
        now,
        frequency: settings.frequency,
        lastSentAt: candidate.lastSentAt,
      })
    ) {
      continue;
    }

    processed += 1;

    try {
      const result = await deliverDigestForUser({
        candidate,
        settings,
        now,
      });

      if (result.hadContent) {
        withContent += 1;
      }
      if (result.delivered) {
        delivered += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error(
        'Digest delivery failed for candidate (continuing batch)',
        {
          userId: candidate.id,
          frequency: settings.frequency,
          deliveryChannel: settings.deliveryChannel,
          error: error instanceof Error ? error.message : String(error),
        },
        'NotificationsDigestCron'
      );
    }
  }

  const payload = {
    success: true,
    processed,
    delivered,
    withContent,
    failed,
    ...(isFanOut && { skippedPartition }),
  };

  recordCronExecution('notifications-digest', startTime, payload);
  return successResponse(payload);
};

export const POST = withErrorHandling(cronHandler);
export const GET = withErrorHandling(cronHandler);
