/**
 * Admin Moderation Escrow Refund API
 *
 * @route POST /api/admin/moderation-escrow/refund - Refund payment
 * @access Admin
 *
 * @description
 * Refunds an escrow payment back to the recipient. Requires refund transaction
 * hash for on-chain verification. Updates payment status to refunded.
 *
 * @openapi
 * /api/admin/moderation-escrow/refund:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Refund escrow payment
 *     description: Refunds payment back to recipient (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - escrowId
 *               - refundTxHash
 *             properties:
 *               escrowId:
 *                 type: string
 *               refundTxHash:
 *                 type: string
 *                 description: Refund transaction hash
 *               reason:
 *                 type: string
 *                 description: Optional refund reason
 *     responses:
 *       200:
 *         description: Refund processed successfully
 *       400:
 *         description: Invalid escrow or transaction
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/moderation-escrow/refund', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({
 *     escrowId: 'escrow-id',
 *     refundTxHash: '0x...',
 *     reason: 'Payment error'
 *   })
 * });
 * ```
 */

import { requireAdmin, withErrorHandling } from '@feed/api';
import { db } from '@feed/db';
import { logger, toISOOrNull } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const RefundEscrowSchema = z.object({
  escrowId: z.string().min(1, 'Escrow ID is required'),
  refundTxHash: z.string().min(1, 'Refund transaction hash is required'),
  reason: z.string().optional(),
});

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const _adminUser = await requireAdmin(req);
  const adminId = _adminUser.userId;

  const body = await req.json();
  const validation = RefundEscrowSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        error: validation.error.issues[0]?.message || 'Invalid request data',
      },
      { status: 400 }
    );
  }

  const { escrowId, refundTxHash, reason } = validation.data;

  // Get escrow record
  const escrow = await db.moderationEscrow.findUnique({
    where: { id: escrowId },
    include: {
      User: {
        select: {
          id: true,
          username: true,
          displayName: true,
          walletAddress: true,
        },
      },
    },
  });

  if (!escrow) {
    return NextResponse.json(
      { error: 'Escrow payment not found' },
      { status: 404 }
    );
  }

  if (escrow.status !== 'paid') {
    return NextResponse.json(
      {
        error: `Cannot refund escrow payment with status: ${escrow.status}. Only 'paid' escrows can be refunded.`,
      },
      { status: 400 }
    );
  }

  if (escrow.refundTxHash) {
    return NextResponse.json(
      { error: 'Escrow payment has already been refunded' },
      { status: 400 }
    );
  }

  // Verify refund transaction exists and is valid
  // Note: In production, you should verify:
  // 1. Transaction exists on-chain
  // 2. Transaction is from treasury to recipient
  // 3. Transaction amount matches escrow amount
  // For now, we trust admin but log the refund
  const refundTxValid =
    refundTxHash.startsWith('0x') && refundTxHash.length === 66;
  if (!refundTxValid) {
    return NextResponse.json(
      { error: 'Invalid refund transaction hash format' },
      { status: 400 }
    );
  }

  // Use transaction to prevent race conditions
  const updatedEscrow = await db.$transaction(async (tx) => {
    // Re-fetch to ensure still refundable
    const currentEscrow = await tx.moderationEscrow.findUnique({
      where: { id: escrowId },
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
      where: { id: escrowId },
      data: {
        status: 'refunded',
        refundTxHash,
        refundedBy: adminId,
        refundedAt: new Date(),
        metadata: {
          ...((currentEscrow.metadata as Record<string, unknown>) || {}),
          refundReason: reason || null,
        },
      },
    });
  });

  logger.info(
    `Admin ${adminId} refunded escrow payment ${escrowId}`,
    {
      adminId,
      escrowId,
      recipientId: escrow.recipientId,
      amountUSD: escrow.amountUSD,
      refundTxHash,
      reason,
    },
    'ModerationEscrow'
  );

  return NextResponse.json({
    success: true,
    escrow: {
      id: updatedEscrow.id,
      recipientId: updatedEscrow.recipientId,
      amountUSD: updatedEscrow.amountUSD,
      status: updatedEscrow.status,
      refundTxHash: updatedEscrow.refundTxHash,
      refundedAt: toISOOrNull(updatedEscrow.refundedAt),
    },
  });
});
