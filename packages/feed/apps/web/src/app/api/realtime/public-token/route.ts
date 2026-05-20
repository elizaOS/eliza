/**
 * Public Realtime Token API
 *
 * GET /api/realtime/public-token
 *
 * Issues a short-lived token scoped only to public SSE channels (feed, markets,
 * breaking-news, upcoming-events). No authentication required. Rate limited
 * by IP (PUBLIC_FIREHOSE: 5 connections/min per IP) to prevent abuse.
 *
 * WHY: Allows read-only clients (dashboards, embeds, public feeds) to subscribe
 * to the public firehose without logging in. Private channels (DMs, notifications,
 * agent streams) remain behind POST /api/realtime/token which requires auth.
 *
 * WHY __public__ userId: The SSE endpoint expects a non-empty userId in the token
 * payload for validation. We use a sentinel value so the same verifyRealtimeToken
 * flow works; the token's channel list already restricts to public channels only.
 *
 * Use the returned token with GET /api/sse/events?token=<token> to subscribe
 * to public realtime events without logging in.
 */

import {
  addPublicReadHeaders,
  issueRealtimeToken,
  publicRateLimit,
  type RealtimeChannel,
  withErrorHandling,
} from '@babylon/api';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/** Public channels only; no chat:, notifications:, or agent: channels. */
const PUBLIC_CHANNELS: RealtimeChannel[] = [
  'feed',
  'markets',
  'breaking-news',
  'upcoming-events',
];

/** Sentinel userId in token payload so SSE validation accepts the token without a real user. */
const PUBLIC_TOKEN_USER_ID = '__public__';
/** 15 minutes; balance between reducing token refresh traffic and limiting exposure if token leaks. */
const TTL_SECONDS = 900;

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const { error, rateLimitInfo } = await publicRateLimit(request, 'firehose');
  if (error) return error;

  const token = issueRealtimeToken({
    userId: PUBLIC_TOKEN_USER_ID,
    channels: PUBLIC_CHANNELS,
    ttlSeconds: TTL_SECONDS,
  });

  const expiresAt = Date.now() + TTL_SECONDS * 1000;

  logger.info(
    'Issued public realtime token',
    { channels: PUBLIC_CHANNELS },
    'Realtime'
  );

  const res = NextResponse.json({
    token,
    channels: PUBLIC_CHANNELS,
    expiresAt,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
