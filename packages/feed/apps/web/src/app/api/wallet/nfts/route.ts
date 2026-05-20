/**
 * Wallet NFT Portfolio API
 *
 * @route GET /api/wallet/nfts?address=0x...
 * @access Authenticated
 *
 * @description
 * Returns NFTs owned by the given wallet address.
 * Phase 3a: ProtoMonkeys collection only (existing indexer + DB fallback).
 * Groups results by collection for the portfolio UI.
 */

import {
  authenticateUser,
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  getNftCollectionIdFromEnv,
  getOwnedTokenIdsFromIndexer,
  NftIndexerUnavailableError,
} from '@feed/api/services/nft-indexer-service';
import { db, eq, inArray, nftCollection, nftOwnership } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isAddress } from 'viem';

import { walletOptionsResponse } from '../_cors';

// OPTIONS wrapped for consistency: same error/Sentry path as GET/POST; overhead negligible.
export const OPTIONS = withErrorHandling(async () => walletOptionsResponse());

export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticateUser(request);

  const rateLimit = await checkRateLimitAsync(
    user.id,
    RATE_LIMIT_CONFIGS.WALLET_READ
  );
  if (!rateLimit.allowed) {
    const retryAfterSeconds = rateLimit.retryAfter || 60;
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
    );
  }

  const address = request.nextUrl.searchParams.get('address');
  if (!address || !isAddress(address)) {
    return NextResponse.json(
      { error: 'Invalid or missing address parameter' },
      { status: 400 }
    );
  }

  const walletAddress = address.toLowerCase();

  // Verify ProtoMonkeys collection is configured
  try {
    getNftCollectionIdFromEnv();
  } catch {
    // NFT_CONTRACT_ADDRESS not configured — return empty portfolio
    return successResponse({ collections: [], totalCount: 0 });
  }

  // Fetch owned token IDs from the indexer (with DB fallback)
  let tokenIds: number[] = [];
  let degraded = false;

  try {
    tokenIds = await getOwnedTokenIdsFromIndexer(walletAddress, { limit: 200 });
  } catch (error) {
    if (
      error instanceof NftIndexerUnavailableError ||
      (error instanceof Error && error.name === 'ValidationError')
    ) {
      degraded = true;
      logger.warn(
        'NFT indexer unavailable for wallet portfolio, falling back to DB',
        { address: walletAddress },
        'GET /api/wallet/nfts'
      );

      // DB fallback: query nftOwnership by address
      const ownershipRows = await db
        .select({ tokenId: nftOwnership.tokenId })
        .from(nftOwnership)
        .where(eq(nftOwnership.ownerAddress, walletAddress));
      tokenIds = ownershipRows.map((r) => r.tokenId);
    } else {
      throw error;
    }
  }

  if (tokenIds.length === 0) {
    return successResponse({ collections: [], totalCount: 0 });
  }

  const uniqueTokenIds = Array.from(new Set(tokenIds)).sort((a, b) => a - b);

  // Fetch metadata from nftCollection table
  const rows = await db
    .select({
      tokenId: nftCollection.tokenId,
      name: nftCollection.name,
      imageUrl: nftCollection.imageUrl,
      thumbnailUrl: nftCollection.thumbnailUrl,
      contractAddress: nftCollection.contractAddress,
    })
    .from(nftCollection)
    .where(inArray(nftCollection.tokenId, uniqueTokenIds));

  const items = rows.map((row) => ({
    contractAddress: row.contractAddress,
    collectionName: 'ProtoMonkeys',
    tokenId: row.tokenId,
    name: row.name,
    imageUrl: row.imageUrl,
    thumbnailUrl: row.thumbnailUrl,
  }));

  // Group by collection
  const collectionMap = new Map<
    string,
    {
      name: string;
      contractAddress: string;
      items: typeof items;
    }
  >();

  for (const item of items) {
    const key = item.contractAddress;
    const existing = collectionMap.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      collectionMap.set(key, {
        name: item.collectionName,
        contractAddress: item.contractAddress,
        items: [item],
      });
    }
  }

  const collections = Array.from(collectionMap.values());

  logger.debug(
    'Wallet NFT portfolio fetched',
    {
      address: walletAddress,
      totalCount: items.length,
      collections: collections.length,
      degraded,
    },
    'GET /api/wallet/nfts'
  );

  return successResponse({
    collections,
    totalCount: items.length,
  });
});
