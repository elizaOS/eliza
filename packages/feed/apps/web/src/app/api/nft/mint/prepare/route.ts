import { authenticate, successResponse, withErrorHandling } from '@babylon/api';
import { prepareMint } from '@babylon/api/services/nft-mint-service';
import type { NextRequest } from 'next/server';

/**
 * POST /api/nft/mint/prepare
 *
 * Prepares a mint transaction with signature for eligible users.
 * Returns contract address, chain ID, encoded call data, and ECDSA signature.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;
  return successResponse(await prepareMint(userId));
});
