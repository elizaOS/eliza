/**
 * Twitter Auth Status API
 *
 * @route GET /api/twitter/auth-status - Check Twitter connection status
 * @access Authenticated
 *
 * @description
 * Checks if authenticated user has connected their Twitter account via OAuth 2.0.
 * Returns connection status and username if connected.
 *
 * @openapi
 * /api/twitter/auth-status:
 *   get:
 *     tags:
 *       - Twitter
 *     summary: Check Twitter connection status
 *     description: Returns whether user has connected Twitter account
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     connected:
 *                       type: boolean
 *                       example: false
 *                 - type: object
 *                   properties:
 *                     connected:
 *                       type: boolean
 *                       example: true
 *                     screenName:
 *                       type: string
 *                     connectedAt:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * const { connected, screenName } = await fetch('/api/twitter/auth-status', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import {
  authenticate,
  requireUserByIdentifier,
  withErrorHandling,
} from "@feed/api";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const authUser = await authenticate(request);
  const user = await requireUserByIdentifier(authUser.userId, {
    id: true,
    twitterAccessToken: true,
    twitterUsername: true,
    updatedAt: true,
  });

  if (!user.twitterAccessToken) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    screenName: user.twitterUsername,
    connectedAt: user.updatedAt,
  });
});
