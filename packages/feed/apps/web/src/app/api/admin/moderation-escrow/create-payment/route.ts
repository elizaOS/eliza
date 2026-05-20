/**
 * Admin Moderation Escrow Create Payment API
 *
 * @route POST /api/admin/moderation-escrow/create-payment - Create escrow payment
 * @access Admin
 *
 * @description
 * Creates a moderation escrow payment request using X402 escrow system.
 * Admin can send money to users with escrow protection. Returns payment
 * request details for on-chain completion.
 *
 * @openapi
 * /api/admin/moderation-escrow/create-payment:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Create escrow payment
 *     description: Creates escrow payment request via X402 (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - recipientId
 *               - amount
 *             properties:
 *               recipientId:
 *                 type: string
 *               amount:
 *                 type: string
 *                 description: Amount in ETH (as string)
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment request created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 escrowId:
 *                   type: string
 *                 paymentRequest:
 *                   type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/moderation-escrow/create-payment', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({
 *     recipientId: 'user-id',
 *     amount: '0.1',
 *     reason: 'Moderation reward'
 *   })
 * });
 * ```
 */

import { X402Manager } from '@babylon/a2a';
import { requireAdmin, withErrorHandling } from '@babylon/api';
import { db } from '@babylon/db';
import { generateSnowflakeId, logger, toISO } from '@babylon/shared';
import { parseEther } from 'ethers';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

// Initialize x402 manager
const x402Manager = new X402Manager({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org',
  paymentTimeout: 15 * 60 * 1000, // 15 minutes
});

// Payment receiver address (treasury/admin wallet)
// Note: Falls back to zero address if not configured - this should be validated in production
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

const CreateEscrowPaymentSchema = z.object({
  recipientId: z.string().min(1, 'Recipient ID is required'),
  amountUSD: z.number().positive('Amount must be positive'),
  reason: z.string().optional(),
  recipientWalletAddress: z
    .string()
    .min(1, 'Recipient wallet address is required'),
});

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const _adminUser = await requireAdmin(req);
  const adminId = _adminUser.userId;

  const body = await req.json();
  const validation = CreateEscrowPaymentSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        error: validation.error.issues[0]?.message || 'Invalid request data',
      },
      { status: 400 }
    );
  }

  const { recipientId, amountUSD, reason, recipientWalletAddress } =
    validation.data;

  // Verify recipient exists and is not an actor
  const recipient = await db.user.findUnique({
    where: { id: recipientId },
    select: {
      id: true,
      username: true,
      displayName: true,
      isActor: true,
      walletAddress: true,
    },
  });

  if (!recipient) {
    return NextResponse.json(
      { error: 'Recipient user not found' },
      { status: 404 }
    );
  }

  if (recipient.isActor) {
    return NextResponse.json(
      { error: 'Cannot send escrow payment to NPCs/actors' },
      { status: 400 }
    );
  }

  // Validate recipient wallet address matches user's actual wallet
  if (
    recipient.walletAddress &&
    recipientWalletAddress.toLowerCase() !==
      recipient.walletAddress.toLowerCase()
  ) {
    return NextResponse.json(
      {
        error:
          "Recipient wallet address does not match user's registered wallet address",
      },
      { status: 400 }
    );
  }

  // Prevent self-payment
  if (recipientId === adminId) {
    return NextResponse.json(
      { error: 'Cannot create escrow payment to yourself' },
      { status: 400 }
    );
  }

  // Convert USD to ETH (assuming $1 = 0.001 ETH, adjust as needed)
  const ethEquivalent = amountUSD * 0.001;
  const amountInWei = parseEther(ethEquivalent.toString()).toString();

  // Get admin's wallet address (required for payment)
  const adminWalletAddress = _adminUser.walletAddress;
  if (!adminWalletAddress) {
    return NextResponse.json(
      {
        error:
          'Admin must have a connected wallet address to create escrow payments',
      },
      { status: 400 }
    );
  }

  // Check for duplicate recent escrows BEFORE creating payment request (prevent spam and orphaned requests)
  const recentDuplicate = await db.moderationEscrow.findFirst({
    where: {
      recipientId,
      adminId,
      amountUSD: amountUSD.toString(),
      createdAt: {
        gte: new Date(Date.now() - 5 * 60 * 1000), // Last 5 minutes
      },
      status: {
        in: ['pending', 'paid'],
      },
    },
  });

  if (recentDuplicate) {
    return NextResponse.json(
      {
        error:
          'A similar escrow payment was created recently. Please wait before creating another.',
      },
      { status: 400 }
    );
  }

  // Create X402 payment request
  // Note: 'from' is admin's wallet (who sends), 'to' is treasury (escrow holder)
  // The recipientWalletAddress is stored in metadata for refund purposes
  const paymentRequest = await x402Manager.createPaymentRequest(
    adminWalletAddress, // Admin sends the payment
    PAYMENT_RECEIVER, // To treasury/escrow account
    amountInWei,
    'moderation_escrow',
    {
      adminId,
      recipientId,
      recipientWalletAddress, // Store recipient address for refunds
      amountUSD,
      reason: reason || null,
    }
  );

  // Create escrow record in database
  const expiresAt = new Date(paymentRequest.expiresAt);
  const escrow = await db.moderationEscrow.create({
    data: {
      id: await generateSnowflakeId(),
      recipientId,
      adminId,
      amountUSD: amountUSD.toString(),
      amountWei: amountInWei,
      status: 'pending',
      reason: reason || null,
      paymentRequestId: paymentRequest.requestId,
      expiresAt,
      updatedAt: new Date(),
      metadata: {
        recipientWalletAddress,
        adminWalletAddress: adminWalletAddress,
      },
    },
  });

  logger.info(
    `Admin ${adminId} created escrow payment for user ${recipientId}`,
    {
      adminId,
      recipientId,
      amountUSD,
      escrowId: escrow.id,
      paymentRequestId: paymentRequest.requestId,
    },
    'ModerationEscrow'
  );

  return NextResponse.json({
    success: true,
    escrow: {
      id: escrow.id,
      recipientId: escrow.recipientId,
      amountUSD: escrow.amountUSD,
      status: escrow.status,
      reason: escrow.reason,
      paymentRequestId: escrow.paymentRequestId,
      expiresAt: toISO(escrow.expiresAt),
    },
    paymentRequest: {
      requestId: paymentRequest.requestId,
      amount: paymentRequest.amount,
      from: paymentRequest.from,
      to: paymentRequest.to,
      expiresAt: paymentRequest.expiresAt,
    },
  });
});
