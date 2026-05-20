import {
  addPublicReadHeaders,
  BadRequestError,
  publicRateLimit,
  withErrorHandling,
} from '@babylon/api';
import { getTokenMetadata } from '@babylon/api/services/nft-mint-service';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/nft/metadata/[tokenId]
 *
 * Returns ERC-721 compatible metadata (OpenSea standard).
 * Used by the smart contract's tokenURI function.
 * Cached for 1 hour with stale-while-revalidate.
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ tokenId: string }> }
  ) => {
    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const { tokenId: tokenIdParam } = await params;
    if (!/^\d+$/.test(tokenIdParam)) {
      throw new BadRequestError('Token ID must be between 1 and 100');
    }

    const tokenId = Number(tokenIdParam);

    if (!Number.isSafeInteger(tokenId) || tokenId < 1 || tokenId > 100) {
      throw new BadRequestError('Token ID must be between 1 and 100');
    }

    const cacheControl = 'public, max-age=3600, stale-while-revalidate=86400';
    const res = NextResponse.json(await getTokenMetadata(tokenId), {
      headers: {
        'Cache-Control': cacheControl,
      },
    });
    if (rateLimitInfo) {
      addPublicReadHeaders(res, rateLimitInfo);
      res.headers.set('Cache-Control', cacheControl);
    }
    return res;
  }
);
