/**
 * User On-Chain Onboarding API
 *
 * @route POST /api/users/onboarding/onchain - Register user on-chain
 * @access Authenticated
 *
 * @description
 * Triggers on-chain registration for a user. Registers user to EIP-8004
 * Identity Registry on Base Sepolia. Supports referral codes.
 *
 * @openapi
 * /api/users/onboarding/onchain:
 *   post:
 *     tags:
 *       - Users
 *     summary: Register user on-chain
 *     description: Registers user to EIP-8004 Identity Registry (authenticated user only)
 *     security:
 *       - PrivyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               walletAddress:
 *                 type: string
 *                 nullable: true
 *               txHash:
 *                 type: string
 *                 nullable: true
 *               referralCode:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Registration completed successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       409:
 *         description: Already registered
 *
 * @example
 * ```typescript
 * await fetch('/api/users/onboarding/onchain', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     walletAddress: '0x...',
 *     referralCode: 'REF123'
 *   })
 * });
 * ```
 */

import type { JsonValue } from "@polyagent/api";
import {
  authenticate,
  BusinessLogicError,
  ConflictError,
  processOnchainRegistration,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import { db, eq, users } from "@polyagent/db";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";

interface OnchainRequestBody {
  walletAddress?: string | null;
  txHash?: string | null;
  referralCode?: string | null;
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const body = (await request.json()) as
    | OnchainRequestBody
    | Record<string, JsonValue>;

  const txHash =
    typeof (body as OnchainRequestBody).txHash === "string"
      ? (body as OnchainRequestBody).txHash?.trim() || null
      : null;
  const walletOverride =
    typeof (body as OnchainRequestBody).walletAddress === "string"
      ? (body as OnchainRequestBody).walletAddress?.trim() || null
      : null;
  const referralCode =
    typeof (body as OnchainRequestBody).referralCode === "string"
      ? (body as OnchainRequestBody).referralCode?.trim() || null
      : null;

  const canonicalUserId = authUser.dbUserId ?? authUser.userId;

  const [dbUser] = await db
    .select({
      id: users.id,
      privyId: users.privyId,
      username: users.username,
      displayName: users.displayName,
      bio: users.bio,
      profileImageUrl: users.profileImageUrl,
      coverImageUrl: users.coverImageUrl,
      walletAddress: users.walletAddress,
      onChainRegistered: users.onChainRegistered,
      nftTokenId: users.nftTokenId,
      referredBy: users.referredBy,
    })
    .from(users)
    .where(eq(users.id, canonicalUserId))
    .limit(1);

  if (!dbUser) {
    throw new ConflictError(
      "User record not found. Complete signup before on-chain registration.",
      "User",
    );
  }

  if (!dbUser.username || !dbUser.displayName) {
    throw new BusinessLogicError(
      "User profile incomplete. Finish signup before on-chain registration.",
      "PROFILE_INCOMPLETE",
    );
  }

  const walletAddress =
    walletOverride?.toLowerCase() ??
    dbUser.walletAddress ??
    authUser.walletAddress;
  if (!walletAddress) {
    throw new BusinessLogicError(
      "Wallet address is required for on-chain registration.",
      "WALLET_REQUIRED",
    );
  }

  const onchainResult = await processOnchainRegistration({
    user: authUser,
    walletAddress,
    username: dbUser.username,
    displayName: dbUser.displayName,
    bio: dbUser.bio ?? undefined,
    profileImageUrl: dbUser.profileImageUrl ?? undefined,
    coverImageUrl: dbUser.coverImageUrl ?? undefined,
    referralCode,
    txHash,
  });

  const [refreshedUser] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      bio: users.bio,
      profileImageUrl: users.profileImageUrl,
      coverImageUrl: users.coverImageUrl,
      walletAddress: users.walletAddress,
      onChainRegistered: users.onChainRegistered,
      nftTokenId: users.nftTokenId,
      reputationPoints: users.reputationPoints,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, canonicalUserId))
    .limit(1);

  logger.info(
    "User completed on-chain onboarding",
    {
      userId: canonicalUserId,
      alreadyRegistered: onchainResult.alreadyRegistered,
      tokenId: onchainResult.tokenId,
    },
    "POST /api/users/onboarding/onchain",
  );

  return successResponse(
    {
      onchain: onchainResult,
      user: refreshedUser
        ? {
            ...refreshedUser,
            updatedAt: refreshedUser.updatedAt.toISOString(),
          }
        : null,
    },
    200,
  );
});
