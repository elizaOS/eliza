/**
 * Admin NFT Collection Group API
 *
 * @route POST /api/admin/groups/nft-collection - Create NFT-gated group
 * @route GET /api/admin/groups/nft-collection - List NFT-gated groups
 * @access Admin
 *
 * @description
 * Admin-only endpoints for creating and managing NFT-gated group chats.
 * These are groups where access is restricted to holders of specific NFT collections.
 * Users automatically lose access if they transfer or sell their NFT.
 */

import {
  getClientIp,
  logAdminView,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  sql,
} from '@babylon/db';
import { generateSnowflakeId, logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const CreateNftCollectionGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  contractAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid contract address format')
    .transform((addr) => addr.toLowerCase()),
  chainId: z.number().int().positive(),
  tokenId: z.number().int().min(0).nullable().optional(),
});

/**
 * GET /api/admin/groups/nft-collection
 * List all NFT-gated group chats
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);

  logAdminView({
    adminId: admin.userId,
    ipAddress: getClientIp(request.headers) ?? undefined,
    resourceType: 'nft-groups',
    metadata: { action: 'list_nft_gated_groups' },
  });

  const chatsList = await db
    .select({
      id: chats.id,
      name: chats.name,
      groupId: chats.groupId,
      nftGated: chats.nftGated,
      requiredNftContractAddress: chats.requiredNftContractAddress,
      requiredNftTokenId: chats.requiredNftTokenId,
      requiredNftChainId: chats.requiredNftChainId,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(eq(chats.nftGated, true));

  // Get member counts for all chats in a single query using GROUP BY
  const chatIds = chatsList.map((c) => c.id);
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
          eq(chatParticipants.isActive, true)
        )
      )
      .groupBy(chatParticipants.chatId);

    for (const row of memberCountsResult) {
      memberCountMap.set(row.chatId, row.count);
    }
  }

  const nftGatedChats = chatsList.map((chat) => ({
    ...chat,
    memberCount: memberCountMap.get(chat.id) ?? 0,
  }));

  return successResponse({
    groups: nftGatedChats,
    total: nftGatedChats.length,
  });
});

/**
 * POST /api/admin/groups/nft-collection
 * Create a new NFT-gated group chat for an NFT collection
 * Only admins can create these collection-based groups
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);
  const body = await request.json();
  const data = CreateNftCollectionGroupSchema.parse(body);

  logAdminView({
    adminId: admin.userId,
    ipAddress: getClientIp(request.headers) ?? undefined,
    resourceType: 'nft-groups',
    metadata: {
      action: 'create_nft_gated_group',
      contractAddress: data.contractAddress,
      chainId: data.chainId,
    },
  });

  // Generate all IDs upfront before transaction
  const [groupId, chatId, memberId, participantId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const now = new Date();

  // Use transaction to ensure atomicity - if any insert fails, all are rolled back
  const result = await db.transaction(async (tx) => {
    // Create the group
    await tx.insert(groups).values({
      id: groupId,
      name: data.name,
      description: data.description ?? null,
      type: 'user',
      ownerId: admin.userId,
      createdById: admin.userId,
      createdAt: now,
      updatedAt: now,
    });

    // Create the NFT-gated chat linked to the group
    await tx.insert(chats).values({
      id: chatId,
      name: data.name,
      description: data.description ?? null,
      isGroup: true,
      groupId,
      createdBy: admin.userId,
      nftGated: true,
      requiredNftContractAddress: data.contractAddress,
      requiredNftTokenId: data.tokenId ?? null,
      requiredNftChainId: data.chainId,
      createdAt: now,
      updatedAt: now,
    });

    // Add admin as owner of the group and chat participant in parallel
    await Promise.all([
      tx.insert(groupMembers).values({
        id: memberId,
        groupId,
        userId: admin.userId,
        role: 'owner',
        addedBy: admin.userId,
        joinedAt: now,
        isActive: true,
      }),
      tx.insert(chatParticipants).values({
        id: participantId,
        chatId,
        userId: admin.userId,
        joinedAt: now,
        isActive: true,
      }),
    ]);

    return { groupId, chatId };
  });

  logger.info(
    'NFT-gated group created by admin',
    {
      adminId: admin.userId,
      groupId: result.groupId,
      chatId: result.chatId,
      contractAddress: data.contractAddress,
      chainId: data.chainId,
    },
    'POST /api/admin/groups/nft-collection'
  );

  return successResponse(
    {
      group: {
        id: result.groupId,
        name: data.name,
        chatId: result.chatId,
        nftGated: true,
        contractAddress: data.contractAddress,
        tokenId: data.tokenId ?? null,
        chainId: data.chainId,
      },
    },
    201
  );
});
