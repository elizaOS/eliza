/**
 * Twitter OAuth Initiation API
 *
 * @route GET /api/auth/twitter/initiate - Initiate Twitter OAuth
 * @access Authenticated
 *
 * @description
 * Initiates Twitter OAuth 2.0 flow with PKCE, redirecting user to Twitter
 * authorization page. Generates secure state parameter with CSRF protection.
 *
 * @openapi
 * /api/auth/twitter/initiate:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Initiate Twitter OAuth
 *     description: Starts Twitter OAuth 2.0 flow with PKCE (redirects to Twitter)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       302:
 *         description: Redirect to Twitter authorization page
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Twitter OAuth not configured
 *
 * @example
 * ```typescript
 * // Redirect user to initiate Twitter OAuth
 * window.location.href = '/api/auth/twitter/initiate';
 * ```
 *
 * @see {@link /api/auth/twitter/callback} OAuth callback
 * @see {@link https://developer.twitter.com/en/docs/authentication/oauth-2-0} Twitter OAuth 2.0
 */

import { authenticate, withErrorHandling } from '@babylon/api';
import { db } from '@babylon/db';
import {
  generateSnowflakeId,
  getWaitlistBaseUrl,
  logger,
  toISO,
} from '@babylon/shared';
import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Generate PKCE code verifier (random string)
 */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate PKCE code challenge from verifier
 */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const authUser = await authenticate(request);
  const userId = authUser.userId;

  // Use | as separator instead of : to avoid conflicts with Privy DIDs (did:privy:...)
  const state = `${userId}|${Date.now()}|${Math.random().toString(36).substring(7)}`;

  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Store code verifier temporarily (expires in 10 minutes)
  const oauthRecord = await db.oAuthState.create({
    data: {
      id: await generateSnowflakeId(),
      userId,
      state,
      codeVerifier,
      returnPath: 'twitter', // Use returnPath to store provider
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  logger.info(
    'Created OAuth state record',
    {
      userId,
      state,
      oauthRecordId: oauthRecord.id,
      expiresAt: toISO(oauthRecord.expiresAt),
    },
    'TwitterInitiate'
  );

  const authUrl = new URL('https://x.com/i/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', process.env.TWITTER_CLIENT_ID!);
  authUrl.searchParams.set(
    'redirect_uri',
    `${getWaitlistBaseUrl()}/api/auth/twitter/callback`
  );
  authUrl.searchParams.set(
    'scope',
    'tweet.read tweet.write users.read offline.access'
  );
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  logger.info(
    'Initiating Twitter OAuth with PKCE',
    { userId, state: state.substring(0, 20) + '...' },
    'TwitterInitiate'
  );

  return NextResponse.redirect(authUrl.toString());
});
