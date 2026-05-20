/**
 * NFT-Gated Chats Discovery API
 *
 * @route GET /api/chats/nft-gated - List available NFT-gated chats
 * @access Authenticated
 *
 * @description
 * Returns a list of NFT-gated chats that the user could potentially join.
 * Shows which chats the user has access to based on their NFT holdings.
 */

import {
  authenticate,
  NFTVerificationService,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  asc,
  chatParticipants,
  chats,
  db,
  desc,
  eq,
  inArray,
  sql,
  users,
} from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

// Pagination constants
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Pagination schema with type coercion and validation
// Uses preprocess to handle empty strings gracefully (treat as undefined)
const PaginationSchema = z.object({
  limit: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
  ),
  offset: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.coerce.number().int().nonnegative().default(0),
  ),
});

/**
 * GET /api/chats/nft-gated
 * List NFT-gated chats the user can potentially join
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Parse and validate pagination parameters using Zod
  const { searchParams } = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: searchParams.get("limit") ?? undefined,
    offset: searchParams.get("offset") ?? undefined,
  });

  // Get user's wallet address
  const [userData] = await db
    .select({ walletAddress: users.walletAddress })
    .from(users)
    .where(eq(users.id, user.userId))
    .limit(1);

  // Get total count of NFT-gated chats for pagination metadata
  const [totalCountResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chats)
    .where(eq(chats.nftGated, true));
  const totalCount = totalCountResult?.count ?? 0;

  // Get paginated NFT-gated chats ordered by createdAt (newest first)
  const nftGatedChats = await db
    .select({
      id: chats.id,
      name: chats.name,
      description: chats.description,
      requiredNftContractAddress: chats.requiredNftContractAddress,
      requiredNftTokenId: chats.requiredNftTokenId,
      requiredNftChainId: chats.requiredNftChainId,
      createdAt: chats.createdAt,
    })
    .from(chats)
    .where(eq(chats.nftGated, true))
    .orderBy(desc(chats.createdAt), asc(chats.id))
    .limit(limit)
    .offset(offset);

  if (nftGatedChats.length === 0) {
    return successResponse({
      chats: [],
      hasWallet: !!userData?.walletAddress,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: false,
      },
    });
  }

  // Get user's current active memberships
  const userMemberships = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(
      and(
        eq(chatParticipants.userId, user.userId),
        eq(chatParticipants.isActive, true),
        inArray(
          chatParticipants.chatId,
          nftGatedChats.map((c) => c.id),
        ),
      ),
    );
  const memberOfSet = new Set(userMemberships.map((m) => m.chatId));

  // Get member counts for all chats in a single query using GROUP BY
  const chatIds = nftGatedChats.map((c) => c.id);
  const memberCountMap = new Map<string, number>();

  if (chatIds.length > 0) {
    const memberCountsResult = await db
      .select({
        chatId: chatParticipants.chatId,
        count: sql<number>`count(*)::int`,
      })
      .from(chatParticipants)
      .where(
        and(
          inArray(chatParticipants.chatId, chatIds),
          eq(chatParticipants.isActive, true),
        ),
      )
      .groupBy(chatParticipants.chatId);

    for (const row of memberCountsResult) {
      memberCountMap.set(row.chatId, row.count);
    }
  }

  // Check NFT access for each chat if user has wallet
  // Process in batches to avoid overwhelming RPC endpoints
  const BATCH_SIZE = 5;
  const chatResults: Array<{
    id: string;
    name: string | null;
    description: string | null;
    memberCount: number;
    nftRequirement: {
      contractAddress: string | null;
      tokenId: number | null;
      chainId: number | null;
    };
    isMember: boolean;
    hasAccess: boolean;
    ownedTokenIds: number[];
    createdAt: Date;
  }> = [];

  for (let i = 0; i < nftGatedChats.length; i += BATCH_SIZE) {
    const batch = nftGatedChats.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (chat) => {
        const isMember = memberOfSet.has(chat.id);
        let hasAccess = false;
        let tokenIds: number[] = [];

        if (userData?.walletAddress && chat.requiredNftContractAddress) {
          try {
            const verification = await NFTVerificationService.verifyChatAccess(
              userData.walletAddress,
              chat.requiredNftContractAddress,
              chat.requiredNftTokenId ?? null,
              chat.requiredNftChainId ?? undefined,
            );
            hasAccess = verification.canAccess;

            // Get owned token IDs if has access
            if (hasAccess && chat.requiredNftTokenId === null) {
              tokenIds = await NFTVerificationService.getUserTokenIds(
                userData.walletAddress,
                chat.requiredNftContractAddress,
                chat.requiredNftChainId ?? undefined,
              ).catch(() => []);
            } else if (hasAccess && chat.requiredNftTokenId !== null) {
              tokenIds = [chat.requiredNftTokenId];
            }
          } catch (error) {
            logger.warn(
              "Error checking NFT access for chat",
              {
                chatId: chat.id,
                error: error instanceof Error ? error.message : String(error),
              },
              "GET /api/chats/nft-gated",
            );
          }
        }

        return {
          id: chat.id,
          name: chat.name,
          description: chat.description,
          memberCount: memberCountMap.get(chat.id) ?? 0,
          nftRequirement: {
            contractAddress: chat.requiredNftContractAddress,
            tokenId: chat.requiredNftTokenId,
            chainId: chat.requiredNftChainId,
          },
          isMember,
          hasAccess,
          ownedTokenIds: tokenIds,
          createdAt: chat.createdAt,
        };
      }),
    );

    chatResults.push(...batchResults);
  }

  // Note: Results are ordered by createdAt DESC from the database query.
  // Client-side sorting by access/membership is left to the frontend since
  // in-memory sorting after pagination would break pagination consistency.

  return successResponse({
    chats: chatResults,
    hasWallet: !!userData?.walletAddress,
    walletAddress: userData?.walletAddress ?? null,
    pagination: {
      total: totalCount,
      limit,
      offset,
      hasMore: offset + nftGatedChats.length < totalCount,
    },
  });
});
