/**
 * OAuth Credentials Status API
 *
 * @route GET /api/auth/credentials/status - Check OAuth credentials status
 * @access Public
 *
 * @description
 * Checks availability of OAuth credentials for social platform integrations.
 * Returns configuration status for Twitter and Farcaster. Used by frontend
 * to conditionally display social login options.
 *
 * @openapi
 * /api/auth/credentials/status:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Check OAuth credentials status
 *     description: Returns configuration status for Twitter and Farcaster OAuth
 *     responses:
 *       200:
 *         description: Credentials status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 twitter:
 *                   type: boolean
 *                   description: Twitter OAuth 2.0 configured
 *                 farcaster:
 *                   type: boolean
 *                   description: Farcaster authentication configured
 *
 * @example
 * ```typescript
 * const { twitter, farcaster } = await fetch('/api/auth/credentials/status')
 *   .then(r => r.json());
 *
 * if (twitter) {
 *   // Show Twitter login button
 * }
 * ```
 *
 * @see {@link /api/auth/twitter/initiate} Twitter OAuth initiation
 * @see {@link /api/auth/farcaster/callback} Farcaster callback
 */

import { NextResponse } from "next/server";

export async function GET() {
  const twitterAvailable = Boolean(
    process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET,
  );

  const farcasterAvailable = Boolean(process.env.NEYNAR_API_KEY);

  return NextResponse.json({
    twitter: twitterAvailable,
    farcaster: farcasterAvailable,
  });
}
