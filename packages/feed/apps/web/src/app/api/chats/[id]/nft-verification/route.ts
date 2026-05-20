import {
  authenticate,
  BusinessLogicError,
  NFTVerificationService,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { asUser } from '@babylon/db';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const user = await authenticate(request);
    const { id: chatId } = await context.params;

    if (!chatId) {
      throw new BusinessLogicError('Chat ID is required', 'CHAT_ID_REQUIRED');
    }

    const result = await asUser(user, async (dbClient) => {
      const chat = await dbClient.chat.findUnique({
        where: { id: chatId },
        select: {
          id: true,
          nftGated: true,
          requiredNftContractAddress: true,
          requiredNftTokenId: true,
          requiredNftChainId: true,
        },
      });

      if (!chat) {
        throw new NotFoundError('Chat', chatId);
      }

      if (!chat.nftGated || !chat.requiredNftContractAddress) {
        return {
          ownsNft: true,
          tokenIds: [],
          nftRequired: false,
        };
      }

      // Use dbClient (Prisma) instead of global db (Drizzle) to maintain RLS context
      const userData = await dbClient.user.findUnique({
        where: { id: user.userId },
        select: { walletAddress: true },
      });

      if (!userData?.walletAddress) {
        return {
          ownsNft: false,
          tokenIds: [],
          nftRequired: true,
          reason: 'Wallet address required',
        };
      }

      const ownsNft = await NFTVerificationService.verifyOwnership(
        userData.walletAddress,
        chat.requiredNftContractAddress,
        chat.requiredNftTokenId ?? null,
        chat.requiredNftChainId ?? undefined
      );

      let tokenIds: number[] = [];
      if (ownsNft && chat.requiredNftTokenId === null) {
        tokenIds = await NFTVerificationService.getUserTokenIds(
          userData.walletAddress,
          chat.requiredNftContractAddress,
          chat.requiredNftChainId ?? undefined
        ).catch(() => []);
      } else if (ownsNft && chat.requiredNftTokenId !== null) {
        tokenIds = [chat.requiredNftTokenId];
      }

      return {
        ownsNft,
        tokenIds,
        nftRequired: true,
        contractAddress: chat.requiredNftContractAddress,
        tokenId: chat.requiredNftTokenId,
        chainId: chat.requiredNftChainId,
      };
    });

    return successResponse(result);
  }
);
