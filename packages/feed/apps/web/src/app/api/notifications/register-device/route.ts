/**
 * Push Notification Device Registration API
 *
 * @route POST /api/notifications/register-device
 * @access Authenticated users only
 *
 * @description
 * Stores a push notification device token (APNs or FCM) for the
 * authenticated user. Called by the Capacitor mobile app after
 * receiving a push token from the OS.
 *
 * Device tokens are stored in Redis with a TTL of 90 days.
 * Each user can have multiple device tokens (multiple devices).
 *
 * @body { platform: 'ios' | 'android', token: string }
 */

import { authenticate, withErrorHandling } from "@feed/api";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Redis key prefix for device tokens
const DEVICE_TOKEN_PREFIX = "push:device:";
// TTL: 90 days (tokens may rotate, stale ones expire)
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

async function getRedis() {
  const { getRedisClient } = await import("@feed/api");
  return getRedisClient();
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;

  const body = await request.json();
  const { platform, token } = body as {
    platform?: string;
    token?: string;
  };

  if (!platform || !token) {
    return NextResponse.json(
      { error: "Missing required fields: platform, token" },
      { status: 400 },
    );
  }

  if (platform !== "ios" && platform !== "android") {
    return NextResponse.json(
      { error: 'Invalid platform. Must be "ios" or "android".' },
      { status: 400 },
    );
  }

  const redis = await getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: "Push notification service unavailable" },
      { status: 503 },
    );
  }

  // Store token in a Redis set for this user (allows multiple devices)
  const key = `${DEVICE_TOKEN_PREFIX}${userId}`;
  const tokenData = JSON.stringify({ platform, token, updatedAt: Date.now() });

  // Use a hash: field = token (deduplicated), value = metadata
  await redis.hset(key, token, tokenData);
  await redis.expire(key, TOKEN_TTL_SECONDS);

  return NextResponse.json({ success: true });
});
