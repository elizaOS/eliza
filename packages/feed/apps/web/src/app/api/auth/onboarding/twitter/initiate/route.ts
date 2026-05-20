/**
 * Twitter Onboarding OAuth Initiate API
 *
 * @route GET /api/auth/onboarding/twitter/initiate - Initiate Twitter OAuth
 * @access Authenticated
 *
 * @description
 * Initiates Twitter OAuth 2.0 flow for importing profile data during onboarding.
 * Redirects user to Twitter authorization page. State includes user ID for callback.
 *
 * @openapi
 * /api/auth/onboarding/twitter/initiate:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Initiate Twitter OAuth for onboarding
 *     description: Redirects to Twitter OAuth authorization page for profile import
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       302:
 *         description: Redirect to Twitter OAuth
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // Redirects to Twitter OAuth
 * window.location.href = '/api/auth/onboarding/twitter/initiate';
 * ```
 */

import { authenticate, withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const user = await authenticate(request);
  const userId = user.userId;

  const state = `onboarding:${userId}:${Date.now()}:${Math.random().toString(36).substring(7)}`;

  const twitterAuthUrl = new URL('https://x.com/i/oauth2/authorize');
  twitterAuthUrl.searchParams.set('response_type', 'code');
  twitterAuthUrl.searchParams.set('client_id', process.env.TWITTER_CLIENT_ID!);
  twitterAuthUrl.searchParams.set(
    'redirect_uri',
    `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/onboarding/twitter/callback`
  );
  twitterAuthUrl.searchParams.set(
    'scope',
    'tweet.read users.read offline.access'
  );
  twitterAuthUrl.searchParams.set('state', state);
  twitterAuthUrl.searchParams.set('code_challenge', 'challenge');
  twitterAuthUrl.searchParams.set('code_challenge_method', 'plain');

  logger.info(
    'Initiating Twitter onboarding OAuth',
    { userId },
    'TwitterOnboardingInitiate'
  );

  return NextResponse.redirect(twitterAuthUrl.toString());
});
