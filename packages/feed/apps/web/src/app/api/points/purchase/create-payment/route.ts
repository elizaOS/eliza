/**
 * Points Purchase Create Payment API
 *
 * @route POST /api/points/purchase/create-payment - Create payment request
 * @access Authenticated
 *
 * @description
 * Creates an x402 payment request for funding trading balance. Returns payment
 * request details for on-chain completion. Uses X402 escrow system.
 *
 * @openapi
 * /api/points/purchase/create-payment:
 *   post:
 *     tags:
 *       - Points
 *     summary: Create payment request for trading balance funding
 *     description: Creates x402 payment request for trading balance funding
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amountUSD
 *               - fromAddress
 *             properties:
 *               amountUSD:
 *                 type: number
 *                 description: Amount in USD
 *               fromAddress:
 *                 type: string
 *                 pattern: '^0x[a-fA-F0-9]{40}$'
 *                 description: User's wallet address
 *     responses:
 *       200:
 *         description: Payment request created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requestId:
 *                   type: string
 *                 paymentRequest:
 *                   type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * await fetch('/api/points/purchase/create-payment', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     amountUSD: 10,
 *     fromAddress: '0x...'
 *   })
 * });
 * ```
 */

import { authenticate, withErrorHandling } from "@feed/api";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getPointsPurchaseX402Manager } from "@/lib/points-purchase-x402";
import { trackServerEvent } from "@/lib/posthog/server";

// Payment receiver address (configure this in your environment)
const PAYMENT_RECEIVER =
  process.env.POINTS_PAYMENT_RECEIVER ||
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
  "0x0000000000000000000000000000000000000000";

interface CreatePaymentBody {
  amountUSD: number; // Amount in USD
  fromAddress: string; // User's wallet address
}

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const authUser = await authenticate(req);
  const userId = authUser.dbUserId!;

  const body: CreatePaymentBody = await req.json();
  const { amountUSD, fromAddress } = body;

  const balanceUnits = Math.floor(amountUSD * 100);

  const ethEquivalent = amountUSD * 0.001;
  const amountInWei = (ethEquivalent * 1_000_000_000_000_000_000).toString();

  const x402Manager = await getPointsPurchaseX402Manager();
  const paymentRequest = await x402Manager.createPaymentRequest(
    fromAddress,
    PAYMENT_RECEIVER,
    amountInWei,
    "trading_balance_purchase",
    {
      userId,
      amountUSD,
      balanceUnits,
    },
  );

  logger.info(
    `Created payment request for ${balanceUnits} balance units ($${amountUSD})`,
    {
      userId,
      requestId: paymentRequest.requestId,
      amountUSD,
      balanceUnits,
    },
    "TradingBalanceFunding",
  );

  void trackServerEvent(userId, "trading_balance_purchase_initiated", {
    amountUSD,
    balanceUnits,
    requestId: paymentRequest.requestId,
  }).catch((err) => {
    logger.warn(
      "Failed to track trading_balance_purchase_initiated",
      { error: err },
      "TradingBalanceFunding",
    );
  });

  return NextResponse.json({
    success: true,
    paymentRequest: {
      requestId: paymentRequest.requestId,
      amount: paymentRequest.amount,
      from: paymentRequest.from,
      to: paymentRequest.to,
      expiresAt: paymentRequest.expiresAt,
      balanceUnits,
      amountUSD,
    },
  });
});
