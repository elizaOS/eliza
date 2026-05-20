/**
 * Push Notification Device Unregistration API
 *
 * @route POST /api/notifications/unregister-device
 * @access Authenticated users only
 *
 * @description
 * Removes all push notification device tokens for the authenticated user.
 * Called by the mobile app on logout. Intentionally removes all devices
 * (not per-platform) — logout should silence push across all sessions.
 */

import { authenticate, withErrorHandling } from '@babylon/api';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const DEVICE_TOKEN_PREFIX = 'push:device:';

async function getRedis() {
  const { getRedisClient } = await import('@babylon/api');
  return getRedisClient();
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;

  const redis = await getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: 'Push notification service unavailable' },
      { status: 503 }
    );
  }

  // Remove all device tokens for this user
  const key = `${DEVICE_TOKEN_PREFIX}${userId}`;
  await redis.del(key);

  return NextResponse.json({ success: true });
});
