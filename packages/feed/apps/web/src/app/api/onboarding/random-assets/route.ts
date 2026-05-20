/**
 * Onboarding Random Assets API
 *
 * @route GET /api/onboarding/random-assets - Get random assets
 * @access Public
 *
 * @description
 * Returns random profile picture and banner indices for onboarding.
 * Used to assign random assets to new users.
 *
 * @openapi
 * /api/onboarding/random-assets:
 *   get:
 *     tags:
 *       - Onboarding
 *     summary: Get random assets
 *     description: Returns random profile picture and banner indices
 *     responses:
 *       200:
 *         description: Assets retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 profilePictureIndex:
 *                   type: integer
 *                   minimum: 1
 *                   maximum: 150
 *                 bannerIndex:
 *                   type: integer
 *                   minimum: 0
 *                   maximum: 99
 *
 * @example
 * ```typescript
 * const { profilePictureIndex, bannerIndex } = await fetch('/api/onboarding/random-assets')
 *   .then(r => r.json());
 * ```
 */

import { successResponse, withErrorHandling } from '@babylon/api';
import { logger, TOTAL_AGENT_DEFAULT_PROFILE_PICTURES } from '@babylon/shared';
import type { NextRequest } from 'next/server';

const TOTAL_BANNERS = 100;

interface RandomAssets {
  profilePictureIndex: number;
  bannerIndex: number;
}

/**
 * GET /api/onboarding/random-assets
 * Get random profile picture and banner indices
 */
export const GET = withErrorHandling(async function GET(_request: NextRequest) {
  const profilePictureIndex =
    Math.floor(Math.random() * TOTAL_AGENT_DEFAULT_PROFILE_PICTURES) + 1;
  const bannerIndex = Math.floor(Math.random() * TOTAL_BANNERS) + 1;

  const assets: RandomAssets = {
    profilePictureIndex,
    bannerIndex,
  };

  logger.debug(
    'Generated random assets',
    assets,
    'GET /api/onboarding/random-assets'
  );

  return successResponse(assets);
});
