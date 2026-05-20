/**
 * Join NFT-Gated Chat API
 *
 * @route POST /api/chats/[id]/join-nft - Join an NFT-gated chat
 * @access Authenticated
 *
 * @description
 * Allows users to join an NFT-gated chat if they hold the required NFT.
 * Verifies NFT ownership before adding the user as a participant.
 */

import {
  authenticate,
  BusinessLogicError,
  NFTVerificationService,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  isUniqueConstraintError,
  messages,
  toDatabaseErrorType,
  users,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/chats/[id]/join-nft
 * Join an NFT-gated chat by verifying NFT ownership
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const user = await authenticate(request);
    const { id: chatId } = await context.params;

    if (!chatId) {
      throw new BusinessLogicError('Chat ID is required', 'CHAT_ID_REQUIRED');
    }

    // Get the chat
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
    });

    if (!chat) {
      throw new NotFoundError('Chat', chatId);
    }

    if (!chat.nftGated || !chat.requiredNftContractAddress) {
      throw new BusinessLogicError(
        'This chat is not NFT-gated',
        'NOT_NFT_GATED'
      );
    }

    // Check if user is already an active participant
    const existingParticipant = await db.query.chatParticipants.findFirst({
      where: and(
        eq(chatParticipants.chatId, chatId),
        eq(chatParticipants.userId, user.userId),
        eq(chatParticipants.isActive, true)
      ),
    });

    if (existingParticipant) {
      return successResponse({
        success: true,
        message: 'Already a member of this chat',
        alreadyMember: true,
      });
    }

    // Get user's wallet address
    const [userData] = await db
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, user.userId))
      .limit(1);

    if (!userData?.walletAddress) {
      throw new BusinessLogicError(
        'You need to connect a wallet to join NFT-gated chats',
        'WALLET_REQUIRED'
      );
    }

    // Invalidate cache and verify NFT ownership with fresh check
    await NFTVerificationService.invalidateOwnershipCache(
      userData.walletAddress,
      chat.requiredNftContractAddress,
      chat.requiredNftChainId ?? undefined
    );

    const verification = await NFTVerificationService.verifyChatAccess(
      userData.walletAddress,
      chat.requiredNftContractAddress,
      chat.requiredNftTokenId ?? null,
      chat.requiredNftChainId ?? undefined
    );

    if (!verification.canAccess) {
      throw new BusinessLogicError(
        verification.reason ??
          'You do not own the required NFT to join this chat',
        'NFT_REQUIRED'
      );
    }

    // Add user to chat using transaction for atomicity
    const now = new Date();

    try {
      await db.transaction(async (tx) => {
        // Check for existing inactive participant and reactivate
        const inactiveParticipant = await tx.query.chatParticipants.findFirst({
          where: and(
            eq(chatParticipants.chatId, chatId),
            eq(chatParticipants.userId, user.userId),
            eq(chatParticipants.isActive, false)
          ),
        });

        if (inactiveParticipant) {
          // Reactivate existing participant
          await tx
            .update(chatParticipants)
            .set({
              isActive: true,
              joinedAt: now,
            })
            .where(eq(chatParticipants.id, inactiveParticipant.id));
        } else {
          // Create new participant
          const participantId = await generateSnowflakeId();
          await tx.insert(chatParticipants).values({
            id: participantId,
            chatId,
            userId: user.userId,
            joinedAt: now,
            isActive: true,
          });
        }

        // If there's a linked group, add to group members
        if (chat.groupId) {
          // Check for existing membership (active or inactive) and reactivate
          const existingMember = await tx.query.groupMembers.findFirst({
            where: and(
              eq(groupMembers.groupId, chat.groupId),
              eq(groupMembers.userId, user.userId)
            ),
          });

          if (existingMember) {
            // Reactivate existing membership
            await tx
              .update(groupMembers)
              .set({
                isActive: true,
                joinedAt: now,
                kickedAt: null,
                kickReason: null,
              })
              .where(eq(groupMembers.id, existingMember.id));
          } else {
            // Create new membership
            const memberId = await generateSnowflakeId();
            await tx.insert(groupMembers).values({
              id: memberId,
              groupId: chat.groupId,
              userId: user.userId,
              role: 'member',
              addedBy: user.userId,
              joinedAt: now,
              isActive: true,
            });
          }
        }
      });
    } catch (error) {
      // Handle race condition - if user was already added by concurrent request
      // Check for PostgreSQL unique constraint violation (code 23505)
      if (isUniqueConstraintError(toDatabaseErrorType(error))) {
        return successResponse({
          success: true,
          message: 'Already a member of this chat',
          alreadyMember: true,
        });
      }
      throw error;
    }

    // Get user's display name for system message
    const [joiningUser] = await db
      .select({ displayName: users.displayName, username: users.username })
      .from(users)
      .where(eq(users.id, user.userId))
      .limit(1);
    const joinerName =
      joiningUser?.displayName || joiningUser?.username || 'Someone';

    // Create system message for joining
    const messageId = await generateSnowflakeId();
    await db.insert(messages).values({
      id: messageId,
      chatId,
      senderId: 'system',
      type: 'system',
      content: `${joinerName} joined the group`,
      createdAt: now,
    });

    logger.info(
      'User joined NFT-gated chat',
      {
        userId: user.userId,
        chatId,
        contractAddress: chat.requiredNftContractAddress,
      },
      'POST /api/chats/[id]/join-nft'
    );

    return successResponse({
      success: true,
      message: 'Successfully joined the chat',
      chat: {
        id: chat.id,
        name: chat.name,
        nftGated: true,
        contractAddress: chat.requiredNftContractAddress,
        tokenId: chat.requiredNftTokenId,
        chainId: chat.requiredNftChainId,
      },
    });
  }
);
