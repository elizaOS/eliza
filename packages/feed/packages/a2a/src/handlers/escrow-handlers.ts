/**
 * A2A Escrow Handlers
 *
 * Handlers for moderation escrow payment methods via A2A protocol
 */

import { and, db, eq, lt, moderationEscrows, sql, users } from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { SQL } from 'drizzle-orm';
import { parseEther } from 'ethers';
import { z } from 'zod';
import { X402Manager } from '../payments/x402-manager';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResult,
} from '../types/a2a';
import { ErrorCode } from '../types/a2a';

// Initialize x402 manager
const x402Manager = new X402Manager({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org',
  paymentTimeout: 15 * 60 * 1000, // 15 minutes
});

const PAYMENT_RECEIVER =
  process.env.MODERATION_ESCROW_RECEIVER ||
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
  '0x0000000000000000000000000000000000000000';

// Validate treasury address is configured (warn if zero address)
if (PAYMENT_RECEIVER === '0x0000000000000000000000000000000000000000') {
  logger.warn(
    'MODERATION_ESCROW_RECEIVER or NEXT_PUBLIC_TREASURY_ADDRESS not configured - using zero address',
    {},
    'ModerationEscrow'
  );
}

// Validation schemas
const CreateEscrowPaymentParamsSchema = z.object({
  recipientId: z.string().min(1),
  amountUSD: z.number().positive(),
  reason: z.string().optional(),
  recipientWalletAddress: z.string().min(1),
});

const VerifyEscrowPaymentParamsSchema = z.object({
  escrowId: z.string().min(1),
  txHash: z.string().min(1),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  amount: z.string().min(1),
});

const RefundEscrowPaymentParamsSchema = z.object({
  escrowId: z.string().min(1),
  refundTxHash: z.string().min(1),
  reason: z.string().optional(),
});

const ListEscrowPaymentsParamsSchema = z.object({
  recipientId: z.string().optional(),
  adminId: z.string().optional(),
  status: z.enum(['pending', 'paid', 'refunded', 'expired']).optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

/**
 * Handle create escrow payment request (Admin only)
 */
export async function handleCreateEscrowPayment(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  // Verify agent is admin
  const adminCheck = await db.user.findUnique({
    where: { id: agentId },
    select: { id: true, isAdmin: true, walletAddress: true },
  });

  if (!adminCheck || !adminCheck.isAdmin) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.FORBIDDEN,
        message: 'Only admins can create escrow payments',
      },
      id: request.id,
    };
  }

  if (!adminCheck.walletAddress) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Admin must have a connected wallet address',
      },
      id: request.id,
    };
  }

  const params = CreateEscrowPaymentParamsSchema.parse(request.params);

  // Prevent self-payment
  if (params.recipientId === agentId) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Cannot create escrow payment to yourself',
      },
      id: request.id,
    };
  }

  // Verify recipient exists and is not an actor
  const recipientCheck = await db.user.findUnique({
    where: { id: params.recipientId },
    select: {
      id: true,
      username: true,
      displayName: true,
      isActor: true,
      walletAddress: true,
    },
  });

  if (!recipientCheck) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Recipient user not found',
      },
      id: request.id,
    };
  }

  if (recipientCheck.isActor) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Cannot send escrow payment to NPCs/actors',
      },
      id: request.id,
    };
  }

  // Validate recipient wallet address matches user's actual wallet
  if (
    recipientCheck.walletAddress &&
    params.recipientWalletAddress.toLowerCase() !==
      recipientCheck.walletAddress.toLowerCase()
  ) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          "Recipient wallet address does not match user's registered wallet address",
      },
      id: request.id,
    };
  }

  // Check for duplicate recent escrows BEFORE creating payment request (prevent spam and orphaned requests)
  const recentDuplicate = await db.moderationEscrow.findFirst({
    where: {
      recipientId: params.recipientId,
      adminId: agentId,
      amountUSD: params.amountUSD.toString(),
      createdAt: {
        gte: new Date(Date.now() - 5 * 60 * 1000), // Last 5 minutes
      },
      status: {
        in: ['pending', 'paid'],
      },
    },
  });

  if (recentDuplicate) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'A similar escrow payment was created recently. Please wait before creating another.',
      },
      id: request.id,
    };
  }

  // Convert USD to ETH
  const ethEquivalent = params.amountUSD * 0.001;
  const amountInWei = parseEther(ethEquivalent.toString()).toString();

  // Create X402 payment request
  // Admin sends payment from their wallet to treasury
  const paymentRequest = await x402Manager.createPaymentRequest(
    adminCheck.walletAddress, // Admin sends
    PAYMENT_RECEIVER, // To treasury
    amountInWei,
    'moderation_escrow',
    {
      adminId: agentId,
      recipientId: params.recipientId,
      recipientWalletAddress: params.recipientWalletAddress, // For refunds
      amountUSD: params.amountUSD,
      reason: params.reason || null,
    }
  );

  // Create escrow record
  const expiresAt = new Date(paymentRequest.expiresAt);
  const [escrow] = await db
    .insert(moderationEscrows)
    .values({
      id: await generateSnowflakeId(),
      recipientId: params.recipientId,
      adminId: agentId,
      amountUSD: params.amountUSD.toString(),
      amountWei: amountInWei,
      status: 'pending',
      reason: params.reason || null,
      paymentRequestId: paymentRequest.requestId,
      expiresAt,
      metadata: {
        recipientWalletAddress: params.recipientWalletAddress,
        adminWalletAddress: adminCheck.walletAddress,
      },
      updatedAt: new Date(),
    })
    .returning();

  if (!escrow) {
    throw new Error('Failed to create escrow record');
  }

  logger.info('A2A Escrow payment created', {
    agentId,
    escrowId: escrow.id,
    recipientId: params.recipientId,
    amountUSD: params.amountUSD,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrow: {
        id: escrow.id,
        recipientId: escrow.recipientId,
        amountUSD: escrow.amountUSD.toString(),
        status: escrow.status,
        reason: escrow.reason,
        paymentRequestId: escrow.paymentRequestId,
        expiresAt: escrow.expiresAt.toISOString(),
      },
      paymentRequest: {
        requestId: paymentRequest.requestId,
        amount: paymentRequest.amount,
        from: paymentRequest.from,
        to: paymentRequest.to,
        expiresAt: paymentRequest.expiresAt,
      },
    },
    id: request.id,
  };
}

/**
 * Handle verify escrow payment request
 */
export async function handleVerifyEscrowPayment(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  // Verify agent is admin
  const admin = await db.user.findUnique({
    where: { id: agentId },
    select: { id: true, isAdmin: true },
  });

  if (!admin || !admin.isAdmin) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.FORBIDDEN,
        message: 'Only admins can verify escrow payments',
      },
      id: request.id,
    };
  }

  const params = VerifyEscrowPaymentParamsSchema.parse(request.params);

  // Get escrow record
  const escrow = await db.moderationEscrow.findUnique({
    where: { id: params.escrowId },
  });

  if (!escrow) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment not found',
      },
      id: request.id,
    };
  }

  // Check if expired
  if (new Date() > escrow.expiresAt) {
    // Auto-expire if expired
    await db.moderationEscrow.update({
      where: { id: params.escrowId },
      data: { status: 'expired' },
    });
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.EXPIRED_REQUEST,
        message: 'Escrow payment has expired',
      },
      id: request.id,
    };
  }

  if (escrow.status !== 'pending') {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: `Escrow payment is already ${escrow.status}`,
      },
      id: request.id,
    };
  }

  if (!escrow.paymentRequestId) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment request ID not found',
      },
      id: request.id,
    };
  }

  // Verify fromAddress matches admin's wallet
  const expectedFromAddress = (
    escrow.metadata as { adminWalletAddress?: string }
  )?.adminWalletAddress;
  if (
    expectedFromAddress &&
    params.fromAddress.toLowerCase() !== expectedFromAddress.toLowerCase()
  ) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Transaction sender does not match admin wallet address',
      },
      id: request.id,
    };
  }

  // Use transaction to prevent race conditions
  const verificationResult = await db.$transaction(async (tx) => {
    // Re-fetch escrow within transaction
    const currentEscrow = await tx.moderationEscrow.findUnique({
      where: { id: params.escrowId },
    });

    if (!currentEscrow || currentEscrow.status !== 'pending') {
      throw new Error(
        `Escrow is already ${currentEscrow?.status || 'not found'}`
      );
    }

    if (!currentEscrow.paymentRequestId) {
      throw new Error('Escrow payment request ID not found');
    }

    // Verify payment via X402
    const x402Result = await x402Manager.verifyPayment({
      requestId: currentEscrow.paymentRequestId,
      txHash: params.txHash,
      from: params.fromAddress,
      to: params.toAddress,
      amount: params.amount,
      timestamp: Date.now(),
      confirmed: true,
    });

    if (!x402Result.verified) {
      throw new Error(x402Result.error || 'Payment verification failed');
    }

    // Update escrow status atomically
    return await tx.moderationEscrow.update({
      where: { id: params.escrowId },
      data: {
        status: 'paid',
        paymentTxHash: params.txHash,
      },
    });
  });

  logger.info('A2A Escrow payment verified', {
    agentId,
    escrowId: params.escrowId,
    txHash: params.txHash,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrow: {
        id: verificationResult.id,
        recipientId: verificationResult.recipientId,
        amountUSD: verificationResult.amountUSD.toString(),
        status: verificationResult.status,
        paymentTxHash: verificationResult.paymentTxHash,
      },
    },
    id: request.id,
  };
}

/**
 * Handle refund escrow payment request (Admin only)
 */
export async function handleRefundEscrowPayment(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  // Verify agent is admin
  const admin = await db.user.findUnique({
    where: { id: agentId },
    select: { id: true, isAdmin: true },
  });

  if (!admin || !admin.isAdmin) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.FORBIDDEN,
        message: 'Only admins can refund escrow payments',
      },
      id: request.id,
    };
  }

  const params = RefundEscrowPaymentParamsSchema.parse(request.params);

  // Get escrow record
  const escrow = await db.moderationEscrow.findUnique({
    where: { id: params.escrowId },
  });

  if (!escrow) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment not found',
      },
      id: request.id,
    };
  }

  if (escrow.status !== 'paid') {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: `Cannot refund escrow payment with status: ${escrow.status}. Only 'paid' escrows can be refunded.`,
      },
      id: request.id,
    };
  }

  if (escrow.refundTxHash) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment has already been refunded',
      },
      id: request.id,
    };
  }

  // Verify refund transaction hash format
  const refundTxValid =
    params.refundTxHash.startsWith('0x') && params.refundTxHash.length === 66;
  if (!refundTxValid) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Invalid refund transaction hash format',
      },
      id: request.id,
    };
  }

  // Use transaction to prevent race conditions
  const updatedEscrow = await db.$transaction(async (tx) => {
    // Re-fetch to ensure still refundable
    const currentEscrow = await tx.moderationEscrow.findUnique({
      where: { id: params.escrowId },
    });

    if (!currentEscrow || currentEscrow.status !== 'paid') {
      throw new Error(
        `Cannot refund escrow with status: ${currentEscrow?.status || 'not found'}`
      );
    }

    if (currentEscrow.refundTxHash) {
      throw new Error('Escrow payment has already been refunded');
    }

    // Update escrow status to refunded
    return await tx.moderationEscrow.update({
      where: { id: params.escrowId },
      data: {
        status: 'refunded',
        refundTxHash: params.refundTxHash,
        refundedBy: agentId,
        refundedAt: new Date(),
        metadata: {
          ...((currentEscrow.metadata as Record<string, unknown>) || {}),
          refundReason: params.reason || null,
        },
      },
    });
  });

  logger.info('A2A Escrow payment refunded', {
    agentId,
    escrowId: params.escrowId,
    refundTxHash: params.refundTxHash,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrow: {
        id: updatedEscrow.id,
        recipientId: updatedEscrow.recipientId,
        amountUSD: updatedEscrow.amountUSD.toString(),
        status: updatedEscrow.status,
        refundTxHash: updatedEscrow.refundTxHash,
        refundedAt: updatedEscrow.refundedAt?.toISOString(),
      },
    } as JsonRpcResult,
    id: request.id,
  };
}

/**
 * Handle list escrow payments request
 */
export async function handleListEscrowPayments(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  // Verify agent is admin
  const admin = await db.user.findUnique({
    where: { id: agentId },
    select: { id: true, isAdmin: true },
  });

  if (!admin || !admin.isAdmin) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.FORBIDDEN,
        message: 'Only admins can list escrow payments',
      },
      id: request.id,
    };
  }

  const params = ListEscrowPaymentsParamsSchema.parse(request.params);

  // Auto-expire old pending escrows before querying
  const now = new Date();
  await db
    .update(moderationEscrows)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(moderationEscrows.status, 'pending'),
        lt(moderationEscrows.expiresAt, now)
      )
    );

  const whereConditions: SQL<unknown>[] = [];
  if (params.recipientId)
    whereConditions.push(eq(moderationEscrows.recipientId, params.recipientId));
  if (params.adminId)
    whereConditions.push(eq(moderationEscrows.adminId, params.adminId));
  if (params.status)
    whereConditions.push(eq(moderationEscrows.status, params.status));
  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  const [escrowsRaw, totalResult] = await Promise.all([
    db.query.moderationEscrows.findMany({
      where: whereClause
        ? (moderationEscrows, { eq, and: andFn }) => {
            const conditions: SQL<unknown>[] = [];
            if (params.recipientId)
              conditions.push(
                eq(moderationEscrows.recipientId, params.recipientId)
              );
            if (params.adminId)
              conditions.push(eq(moderationEscrows.adminId, params.adminId));
            if (params.status)
              conditions.push(eq(moderationEscrows.status, params.status));
            return conditions.length > 0 ? andFn(...conditions) : undefined;
          }
        : undefined,
      orderBy: (moderationEscrows, { desc: descFn }) => [
        descFn(moderationEscrows.createdAt),
      ],
      limit: params.limit,
      offset: params.offset,
      with: {
        recipient: {
          columns: {
            id: true,
            username: true,
            displayName: true,
            profileImageUrl: true,
          },
        },
        admin: {
          columns: {
            id: true,
            username: true,
            displayName: true,
          },
        },
        refundedByUser: {
          columns: {
            id: true,
            username: true,
            displayName: true,
          },
        },
      },
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(moderationEscrows)
      .where(whereClause),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrows: escrowsRaw.map((escrow) => ({
        id: escrow.id,
        recipientId: escrow.recipientId,
        recipient: escrow.recipient,
        adminId: escrow.adminId,
        admin: escrow.admin,
        amountUSD: escrow.amountUSD.toString(),
        amountWei: escrow.amountWei,
        status: escrow.status,
        reason: escrow.reason,
        paymentRequestId: escrow.paymentRequestId,
        paymentTxHash: escrow.paymentTxHash,
        refundTxHash: escrow.refundTxHash,
        refundedBy: escrow.refundedBy,
        refundedByUser: escrow.refundedByUser,
        refundedAt: escrow.refundedAt?.toISOString(),
        createdAt: escrow.createdAt.toISOString(),
        expiresAt: escrow.expiresAt.toISOString(),
      })),
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
      },
    } as JsonRpcResult,
    id: request.id,
  };
}

/**
 * Handle appeal ban with escrow payment
 */
export async function handleAppealBanWithEscrow(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const params = z
    .object({
      reason: z.string().min(10).max(2000),
      escrowPaymentTxHash: z.string().min(1), // Escrow payment transaction hash
    })
    .parse(request.params);

  // Get user
  const user = await db.user.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      isBanned: true,
      appealCount: true,
      appealStaked: true,
      appealStatus: true,
      bannedAt: true,
      bannedReason: true,
      walletAddress: true,
    },
  });

  if (!user) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'User not found',
      },
      id: request.id,
    };
  }

  if (!user.isBanned) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'User is not banned',
      },
      id: request.id,
    };
  }

  // Find escrow payment by transaction hash
  const escrow = await db.moderationEscrow.findUnique({
    where: { paymentTxHash: params.escrowPaymentTxHash },
    include: {
      User: {
        select: {
          id: true,
          walletAddress: true,
        },
      },
    },
  });

  if (!escrow) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment not found for this transaction hash',
      },
      id: request.id,
    };
  }

  if (escrow.recipientId !== agentId) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment does not belong to this user',
      },
      id: request.id,
    };
  }

  if (escrow.status !== 'paid') {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: `Escrow payment is not paid (status: ${escrow.status})`,
      },
      id: request.id,
    };
  }

  if (escrow.refundTxHash) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'Escrow payment has been refunded and cannot be used for appeal',
      },
      id: request.id,
    };
  }

  // Check if escrow was already used for an appeal
  const existingAppealWithEscrow = await db.user.findFirst({
    where: {
      appealStakeTxHash: params.escrowPaymentTxHash,
    },
  });

  if (existingAppealWithEscrow) {
    if (existingAppealWithEscrow.id === agentId) {
      return {
        jsonrpc: '2.0',
        error: {
          code: ErrorCode.INVALID_PARAMS,
          message: 'You have already used this escrow payment for an appeal',
        },
        id: request.id,
      };
    }
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'This escrow payment has already been used for an appeal by another user',
      },
      id: request.id,
    };
  }

  // Check if already appealed
  if (user.appealCount >= 1 && !user.appealStaked) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'You have already used your free appeal. You must stake $10 for a second review.',
      },
      id: request.id,
    };
  }

  if (user.appealStaked && user.appealStatus === 'human_review') {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'Your appeal is already in human review. Please wait for a decision.',
      },
      id: request.id,
    };
  }

  // Update user appeal status (using escrow as stake)
  await db
    .update(users)
    .set({
      appealCount: (user.appealCount || 0) + 1,
      appealStaked: true,
      appealStakeAmount: escrow.amountUSD.toString(),
      appealStakeTxHash: params.escrowPaymentTxHash,
      appealStatus: 'lenient_review',
      appealSubmittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, agentId));

  logger.info('A2A Ban appeal with escrow', {
    agentId,
    escrowId: escrow.id,
    amountUSD: escrow.amountUSD,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      message:
        'Appeal submitted with escrow payment. Your appeal is under lenient review.',
      appeal: {
        status: 'lenient_review',
        escrowId: escrow.id,
        amountUSD: escrow.amountUSD.toString(),
      },
    },
    id: request.id,
  };
}
