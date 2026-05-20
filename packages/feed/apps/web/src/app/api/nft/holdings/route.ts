import {
  authenticateWithDbUser,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  getNftCollectionIdFromEnv,
  getOwnedTokenIdsFromDbFallback,
  getOwnedTokenIdsFromIndexer,
  NftIndexerUnavailableError,
} from "@feed/api/services/nft-indexer-service";
import { db, inArray, nftCollection } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import type { NftHoldingsResponse } from "@/types/nft";

export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticateWithDbUser(request);

  const walletAddress = user.walletAddress?.trim() ?? "";
  if (!walletAddress) {
    return successResponse({
      success: true,
      data: {
        walletAddress: null,
        collectionId: null,
        tokenIds: [],
        nfts: [],
        degraded: false,
      },
    } satisfies NftHoldingsResponse);
  }

  let tokenIds: number[] = [];
  let degraded = false;

  try {
    tokenIds = await getOwnedTokenIdsFromIndexer(walletAddress, { limit: 200 });
  } catch (error) {
    if (
      error instanceof NftIndexerUnavailableError ||
      (error instanceof Error && error.name === "ValidationError")
    ) {
      degraded = true;
      logger.warn(
        "NFT indexer unavailable for holdings, falling back to DB ownership",
        { userId: user.dbUserId },
        "GET /api/nft/holdings",
      );
      tokenIds = await getOwnedTokenIdsFromDbFallback(user.dbUserId);
    } else {
      throw error;
    }
  }

  const uniqueTokenIds = Array.from(new Set(tokenIds)).sort((a, b) => a - b);
  const rows =
    uniqueTokenIds.length === 0
      ? []
      : await db
          .select({
            tokenId: nftCollection.tokenId,
            name: nftCollection.name,
            thumbnailUrl: nftCollection.thumbnailUrl,
            imageUrl: nftCollection.imageUrl,
          })
          .from(nftCollection)
          .where(inArray(nftCollection.tokenId, uniqueTokenIds));

  const byId = new Map(rows.map((r) => [r.tokenId, r]));
  const nfts = uniqueTokenIds
    .map((tokenId) => {
      const row = byId.get(tokenId);
      if (!row) return null;
      return {
        tokenId: row.tokenId,
        name: row.name,
        thumbnailUrl: row.thumbnailUrl ?? row.imageUrl,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  const collectionId = (() => {
    try {
      return getNftCollectionIdFromEnv();
    } catch {
      return null;
    }
  })();

  return successResponse({
    success: true,
    data: {
      walletAddress,
      collectionId,
      tokenIds: uniqueTokenIds,
      nfts,
      degraded,
    },
  } satisfies NftHoldingsResponse);
});
