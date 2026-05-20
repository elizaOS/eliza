/**
 * Discord Activity OAuth State Generation API
 *
 * @route GET /api/auth/discord/activity/state - Generate a signed OAuth state token
 * @access Public (called from the Discord Activity iframe before OAuth)
 *
 * @description
 * Generates a cryptographically signed, short-lived state parameter for the
 * Discord Activity OAuth flow. The state token is HMAC-SHA256 signed with the
 * Discord client secret so the token exchange endpoint can verify it was
 * issued by this server, preventing CSRF attacks.
 *
 * Token format: `<uuid>.<timestamp>.<hmac_signature>`
 * - uuid: unique nonce (prevents replay across different flows)
 * - timestamp: issuance time in epoch seconds (enforces TTL)
 * - hmac_signature: hex-encoded HMAC-SHA256 of `<uuid>.<timestamp>`
 */

import { withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import { NextResponse } from 'next/server';
import { generateSignedState } from './state-utils';

export const GET = withErrorHandling(async () => {
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!clientSecret) {
    logger.error(
      'Discord Activity state generation failed: DISCORD_CLIENT_SECRET not configured',
      {},
      'DiscordActivity'
    );
    return NextResponse.json(
      { error: 'Discord Activity not configured' },
      { status: 500 }
    );
  }

  const state = generateSignedState(clientSecret);

  logger.debug(
    'Discord Activity OAuth state token generated',
    {},
    'DiscordActivity'
  );

  return NextResponse.json({ state });
});
