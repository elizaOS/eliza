/**
 * Farcaster Authentication Callback API
 *
 * @route POST /api/auth/farcaster/callback - Link Farcaster account
 * @access Public (with signature verification)
 *
 * @description
 * Handles Farcaster "Sign-In With Farcaster" (SIWF) authentication flow. Verifies
 * signatures via Neynar API, links Farcaster accounts, and awards bonus points.
 *
 * @openapi
 * /api/auth/farcaster/callback:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Link Farcaster account
 *     description: Verifies Farcaster signature and links account (SIWF flow)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *               - signature
 *               - fid
 *               - username
 *               - state
 *             properties:
 *               message:
 *                 type: string
 *                 description: Signed message from Farcaster
 *               signature:
 *                 type: string
 *                 description: Cryptographic signature
 *               fid:
 *                 type: integer
 *                 description: Farcaster ID (FID)
 *               username:
 *                 type: string
 *                 description: Farcaster username
 *               displayName:
 *                 type: string
 *                 description: Display name from Farcaster
 *               pfpUrl:
 *                 type: string
 *                 description: Profile picture URL
 *               state:
 *                 type: string
 *                 description: State parameter (userId:timestamp)
 *     responses:
 *       200:
 *         description: Farcaster account linked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 reputationAwarded:
 *                   type: number
 *                 newReputationTotal:
 *                   type: number
 *       400:
 *         description: Invalid payload or expired state
 *       401:
 *         description: Invalid signature
 *       404:
 *         description: User not found
 *       409:
 *         description: Farcaster account already linked
 *
 * @example
 * ```typescript
 * // Link Farcaster account
 * const result = await fetch('/api/auth/farcaster/callback', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     message: '0x...',
 *     signature: '0x...',
 *     fid: 12345,
 *     username: 'alice',
 *     displayName: 'Alice',
 *     pfpUrl: 'https://...',
 *     state: 'user-123:1234567890'
 *   })
 * });
 *
 * const { reputationAwarded, newReputationTotal } = await result.json();
 * console.log(`Earned ${reputationAwarded} reputation!`);
 * ```
 *
 * @see {@link /lib/services/points-service} Points service
 * @see {@link https://docs.neynar.com} Neynar API documentation
 */

import { createAppClient, viemConnector } from "@farcaster/auth-client";
import { ReputationService, withErrorHandling } from "@feed/api";
import { db } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const FarcasterCallbackBodySchema = z.object({
  message: z.string(),
  signature: z.string(),
  fid: z.number(),
  username: z.string(),
  displayName: z.string().optional(),
  pfpUrl: z.string().url().optional(),
  state: z.string(),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const body = await request.json();
  const parsed = FarcasterCallbackBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { message, signature, fid, username, displayName, pfpUrl, state } =
    parsed.data;

  // Verify state format and get user ID
  // State format: userId|timestamp|random (using pipe because userId may contain colons like steward:test:xxx)
  const stateParts = state.split("|");

  // Format: [userId, timestamp, random]
  if (stateParts.length < 2 || !stateParts[0] || !stateParts[1]) {
    return NextResponse.json(
      { error: "Invalid state format" },
      { status: 400 },
    );
  }
  const userId = stateParts[0];
  const timestampStr = stateParts[1];

  const stateTimestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(stateTimestamp)) {
    return NextResponse.json(
      { error: "Invalid state timestamp" },
      { status: 400 },
    );
  }

  const now = Date.now();

  // State expires after 10 minutes
  if (now - stateTimestamp > 10 * 60 * 1000) {
    return NextResponse.json({ error: "State expired" }, { status: 400 });
  }

  // Verify Farcaster signature and SIWF message content
  const verificationResult = await verifyFarcasterSignature(
    message,
    signature,
    fid,
    request.nextUrl.origin,
  );

  if (!verificationResult.valid) {
    return NextResponse.json(
      { error: verificationResult.error || "Invalid signature" },
      { status: 401 },
    );
  }

  // Check if user exists
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Check if Farcaster account is already linked to another user
  const existingLink = await db.user.findFirst({
    where: {
      farcasterFid: fid.toString(),
      id: { not: userId },
    },
  });

  if (existingLink) {
    return NextResponse.json(
      { error: "Farcaster account already linked to another user" },
      { status: 409 },
    );
  }

  // Update user with Farcaster info
  await db.user.update({
    where: { id: userId },
    data: {
      farcasterFid: fid.toString(),
      farcasterUsername: username,
      hasFarcaster: true,
      farcasterDisplayName: displayName,
      farcasterPfpUrl: pfpUrl,
      farcasterVerifiedAt: new Date(),
    },
  });

  // Award points if this is the first time linking Farcaster
  const pointsResult = await ReputationService.awardFarcasterLink(
    userId,
    username,
  );

  // Check if this qualifies a referral (award bonus to referrer)
  if (pointsResult.success) {
    await ReputationService.checkAndQualifyReferral(userId).catch((error) => {
      // Log error but don't fail the request if qualification check fails
      logger.warn(
        `Failed to check and qualify referral for user ${userId}`,
        { userId, error },
        "FarcasterCallback",
      );
    });
  }

  logger.info(
    "Farcaster account linked successfully",
    {
      userId,
      farcasterUsername: username,
      fid: fid,
      reputationAwarded: pointsResult.reputationAwarded,
    },
    "FarcasterCallback",
  );

  return NextResponse.json({
    success: true,
    reputationAwarded: pointsResult.reputationAwarded,
    newReputationTotal: pointsResult.newReputationTotal,
  });
});

/**
 * Parse SIWF message to extract domain, expiration, and other fields
 * SIWF messages follow EIP-4361 format
 */
function parseSiwfMessage(message: string): {
  domain?: string;
  expirationTime?: string;
  issuedAt?: string;
  nonce?: string;
  uri?: string;
} {
  const result: {
    domain?: string;
    expirationTime?: string;
    issuedAt?: string;
    nonce?: string;
    uri?: string;
  } = {};

  // Extract domain (first line format: "domain.com wants you to sign in...")
  const domainMatch = message.match(/^([^\s]+)\s+wants\s+you\s+to\s+sign/);
  if (domainMatch) {
    result.domain = domainMatch[1];
  }

  // Extract fields from structured format
  const expirationMatch = message.match(/Expiration Time:\s*([^\n]+)/i);
  if (expirationMatch?.[1]) {
    result.expirationTime = expirationMatch[1].trim();
  }

  const issuedAtMatch = message.match(/Issued At:\s*([^\n]+)/i);
  if (issuedAtMatch?.[1]) {
    result.issuedAt = issuedAtMatch[1].trim();
  }

  const nonceMatch = message.match(/Nonce:\s*([^\n]+)/i);
  if (nonceMatch?.[1]) {
    result.nonce = nonceMatch[1].trim();
  }

  const uriMatch = message.match(/URI:\s*([^\n]+)/i);
  if (uriMatch?.[1]) {
    result.uri = uriMatch[1].trim();
  }

  return result;
}

/**
 * Verify Farcaster signature using @farcaster/auth-client
 * Uses the official SIWF verification method with viem connector
 */
async function verifyFarcasterSignature(
  message: string,
  signature: string,
  fid: number,
  requestOrigin?: string,
): Promise<{ valid: boolean; error?: string }> {
  // Parse SIWF message to extract domain and nonce
  const siwfFields = parseSiwfMessage(message);

  // Get the domain for verification
  const appDomain = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
    : requestOrigin
      ? new URL(requestOrigin).hostname
      : null;

  if (!appDomain) {
    logger.error(
      "No domain available for SIWF verification",
      { fid },
      "verifyFarcasterSignature",
    );
    return { valid: false, error: "Configuration error: no domain available" };
  }

  // Log domain info for debugging
  if (
    siwfFields.domain &&
    siwfFields.domain !== appDomain &&
    siwfFields.domain !== `www.${appDomain}`
  ) {
    logger.warn(
      "SIWF domain in message differs from app domain",
      {
        messageDomain: siwfFields.domain,
        appDomain,
        fid,
      },
      "verifyFarcasterSignature",
    );
  }

  // Create the Farcaster auth client with viem connector for signature verification
  const appClient = createAppClient({
    ethereum: viemConnector(),
  });

  // Verify the sign-in message using the official Farcaster auth-client
  const verifyResult = await appClient.verifySignInMessage({
    message,
    signature: signature as `0x${string}`,
    domain: siwfFields.domain || appDomain,
    nonce: siwfFields.nonce || "",
  });

  if (!verifyResult.success) {
    logger.error(
      "SIWF signature verification failed",
      {
        fid,
        providedFid: fid,
        verifiedFid: verifyResult.fid,
      },
      "verifyFarcasterSignature",
    );
    return { valid: false, error: "Signature verification failed" };
  }

  // Verify the FID matches (convert both to string for comparison)
  if (verifyResult.fid.toString() !== fid.toString()) {
    logger.error(
      "SIWF FID mismatch",
      {
        providedFid: fid,
        verifiedFid: verifyResult.fid.toString(),
      },
      "verifyFarcasterSignature",
    );
    return { valid: false, error: "FID mismatch" };
  }

  logger.info(
    "SIWF signature verified successfully",
    {
      fid,
      domain: siwfFields.domain,
    },
    "verifyFarcasterSignature",
  );

  return { valid: true };
}
