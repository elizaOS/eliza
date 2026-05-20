import {
  authenticate,
  BadRequestError,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { confirmMint } from '@babylon/api/services/nft-mint-service';
import type { NextRequest } from 'next/server';
import type { Hex } from 'viem';

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * POST /api/nft/mint/confirm
 *
 * Verifies mint transaction on-chain, extracts token ID from Transfer event,
 * and updates database with ownership records.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;

  const { txHash, walletAddress } = (await request.json()) as {
    txHash: string;
    walletAddress: string;
  };

  if (!txHash || !TX_HASH_RE.test(txHash)) {
    throw new BadRequestError('Invalid transaction hash format');
  }
  if (!walletAddress || !ADDRESS_RE.test(walletAddress)) {
    throw new BadRequestError('Invalid wallet address format');
  }

  return successResponse(
    await confirmMint(userId, txHash as Hex, walletAddress as Hex)
  );
});
