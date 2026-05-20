/**
 * Points Purchase Verify Payment API
 *
 * @route POST /api/points/purchase/verify-payment - Verify payment
 * @access Authenticated
 *
 * @description
 * Verifies an x402 payment and funds the user's trading balance. Checks
 * transaction hash and updates payment status before crediting the wallet.
 *
 * @openapi
 * /api/points/purchase/verify-payment:
 *   post:
 *     tags:
 *       - Points
 *     summary: Verify payment and fund trading balance
 *     description: Verifies on-chain payment and funds trading balance
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - requestId
 *               - txHash
 *               - fromAddress
 *               - toAddress
 *               - amount
 *             properties:
 *               requestId:
 *                 type: string
 *               txHash:
 *                 type: string
 *                 description: On-chain transaction hash
 *               fromAddress:
 *                 type: string
 *                 pattern: '^0x[a-fA-F0-9]{40}$'
 *               toAddress:
 *                 type: string
 *                 pattern: '^0x[a-fA-F0-9]{40}$'
 *               amount:
 *                 type: string
 *                 description: Payment amount
 *     responses:
 *       200:
 *         description: Payment verified and trading balance funded successfully
 *       400:
 *         description: Invalid payment or transaction
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * await fetch('/api/points/purchase/verify-payment', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     requestId: 'request-id',
 *     txHash: '0x...',
 *     fromAddress: '0x...',
 *     toAddress: '0x...',
 *     amount: '10'
 *   })
 * });
 * ```
 */

import {
  authenticate,
  TradingBalanceFundingService,
  withErrorHandling,
} from "@feed/api";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getPointsPurchaseX402Manager } from "@/lib/points-purchase-x402";
import { trackServerEvent } from "@/lib/posthog/server";

interface VerifyPaymentBody {
  requestId: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
}

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const authUser = await authenticate(req);
  const userId = authUser.dbUserId!;

  const body: VerifyPaymentBody = await req.json();
  const { requestId, txHash, fromAddress, toAddress, amount } = body;

  const x402Manager = await getPointsPurchaseX402Manager();
  const verificationResult = await x402Manager.verifyPayment({
    requestId,
    txHash,
    from: fromAddress,
    to: toAddress,
    amount,
    timestamp: Date.now(),
    confirmed: true,
  });

  if (!verificationResult.verified) {
    logger.warn(
      `Payment verification failed for request ${requestId}`,
      { requestId, txHash, error: verificationResult.error },
      "TradingBalanceFunding",
    );
    return NextResponse.json(
      {
        success: false,
        error: verificationResult.error ?? "Payment verification failed",
      },
      { status: 400 },
    );
  }

  const paymentRequest = await x402Manager.getPaymentRequest(requestId);
  if (!paymentRequest?.metadata) {
    // Payment verified on-chain but request data is missing — this is a
    // server-side state inconsistency, not a client error. Use 500 so the
    // client knows to retry rather than treating the request as permanently bad.
    logger.error(
      "Payment request or metadata missing after verification",
      { requestId },
      "TradingBalanceFunding",
    );
    return NextResponse.json(
      { success: false, error: "Payment request not found" },
      { status: 500 },
    );
  }

  const amountUSD = paymentRequest.metadata.amountUSD as number;
  const result = await TradingBalanceFundingService.fundPurchase(
    userId,
    amountUSD,
    requestId,
    txHash,
  );

  if (result.error) {
    logger.error(
      "Failed to fund trading balance after payment verification",
      { userId, requestId, error: result.error },
      "TradingBalanceFunding",
    );
    return NextResponse.json(
      {
        success: false,
        error: result.error ?? "Failed to fund trading balance",
      },
      { status: 500 },
    );
  }

  const actuallyFunded = !result.alreadyProcessed && result.balanceDelta > 0;
  if (actuallyFunded) {
    logger.info(
      `Successfully funded ${result.balanceDelta} balance units to user ${userId}`,
      {
        userId,
        requestId,
        txHash,
        balanceDelta: result.balanceDelta,
        newBalance: result.newBalance,
      },
      "TradingBalanceFunding",
    );

    trackServerEvent(userId, "trading_balance_purchase_completed", {
      paymentProvider: "crypto",
      amountUSD,
      balanceDelta: result.balanceDelta,
      newBalance: result.newBalance,
      requestId,
      txHash,
    }).catch((err) => {
      logger.warn(
        "Failed to track trading_balance_purchase_completed",
        { error: err },
        "TradingBalanceFunding",
      );
    });
  }

  return NextResponse.json({
    success: true,
    balanceDelta: result.balanceDelta,
    newBalance: result.newBalance,
    txHash,
  });
});
