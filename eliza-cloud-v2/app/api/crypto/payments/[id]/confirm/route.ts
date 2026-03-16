import { type NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { z } from "zod";
import { logger, redact } from "@/lib/utils/logger";

/**
 * Transaction Hash Validation Patterns
 *
 * These patterns validate the FORMAT of transaction hashes for different blockchain networks.
 * Format validation is the first line of defense to reject malformed input quickly.
 *
 * SECURITY NOTE: Format validation alone does NOT verify transaction authenticity.
 * The actual on-chain verification is performed by verifyAndConfirmByTxHash() which:
 *
 * 1. Queries OxaPay API to get the payment status from their blockchain monitoring
 * 2. Verifies the provided txHash matches a transaction recorded by OxaPay for this payment
 * 3. Checks the transaction has sufficient blockchain confirmations (minimum 1)
 * 4. Validates the received amount matches expected amount (with 1% tolerance for fees)
 * 5. Uses database row-level locking to prevent double-spend/race conditions
 *
 * OxaPay verification is sufficient because:
 * - OxaPay monitors blockchain transactions directly via their infrastructure
 * - They track transaction confirmations and amounts in real-time
 * - The payment address is controlled by OxaPay, making transaction verification reliable
 * - We verify the user-provided txHash matches what OxaPay recorded (not just format)
 *
 * @see lib/services/crypto-payments.ts verifyAndConfirmByTxHash() for full implementation
 */
const ethereumTxHashRegex = /^0x[a-fA-F0-9]{64}$/;
const tronTxHashRegex = /^[A-Za-z0-9]{64}$/;
const solanaTxHashRegex = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

/**
 * Validates the FORMAT of a transaction hash for the given network.
 *
 * This is a fast client-side validation to reject malformed hashes early.
 * Full on-chain verification is performed by verifyAndConfirmByTxHash() via OxaPay API.
 *
 * @param hash - The transaction hash to validate
 * @param network - The blockchain network (e.g., "ERC20", "TRC20", "SOLANA")
 * @returns true if the hash format is valid for the network
 */
function validateTransactionHashFormat(hash: string, network: string): boolean {
  const normalizedNetwork = network.toUpperCase();

  if (
    normalizedNetwork.includes("ERC20") ||
    normalizedNetwork.includes("BEP20") ||
    normalizedNetwork.includes("POLYGON") ||
    normalizedNetwork.includes("BASE") ||
    normalizedNetwork.includes("ARB") ||
    normalizedNetwork.includes("OP")
  ) {
    return ethereumTxHashRegex.test(hash);
  }

  if (
    normalizedNetwork.includes("TRC20") ||
    normalizedNetwork.includes("TRON")
  ) {
    return tronTxHashRegex.test(hash);
  }

  if (
    normalizedNetwork.includes("SOL") ||
    normalizedNetwork.includes("SOLANA")
  ) {
    return solanaTxHashRegex.test(hash);
  }

  // Default to Ethereum format for unknown networks
  return ethereumTxHashRegex.test(hash);
}

const confirmSchema = z.object({
  transactionHash: z.string().min(1, "Transaction hash is required"),
});

async function handleConfirmPayment(
  req: NextRequest,
  context?: { params: Promise<{ id: string }> },
) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  if (!context?.params) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const user = await requireAuthWithOrg();
    const { id } = await context.params;

    if (!user.organization_id) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 },
      );
    }

    const payment = await cryptoPaymentsRepository.findById(id);

    if (!payment) {
      logger.warn("[Crypto Payments API] Payment not found", {
        paymentId: redact.paymentId(id),
        ip: redact.ip(ip),
        userId: redact.userId(user.id),
      });
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (payment.organization_id !== user.organization_id) {
      logger.warn("[Crypto Payments API] Unauthorized confirmation attempt", {
        paymentId: redact.paymentId(id),
        ip: redact.ip(ip),
        userId: redact.userId(user.id),
        paymentOrg: redact.orgId(payment.organization_id),
        userOrg: redact.orgId(user.organization_id),
      });
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (payment.status === "confirmed") {
      return NextResponse.json({
        success: true,
        message: "Payment already confirmed",
        status: payment.status,
      });
    }

    if (payment.status === "expired") {
      return NextResponse.json(
        { error: "Payment has expired" },
        { status: 400 },
      );
    }

    const body = await req.json();
    const validation = confirmSchema.safeParse(body);

    if (!validation.success) {
      logger.warn("[Crypto Payments API] Invalid confirmation request", {
        paymentId: redact.paymentId(id),
        ip: redact.ip(ip),
        userId: redact.userId(user.id),
        errors: validation.error.flatten().fieldErrors,
      });
      return NextResponse.json(
        {
          error: "Invalid transaction hash format",
        },
        { status: 400 },
      );
    }

    const { transactionHash } = validation.data;

    // Format validation for fast rejection - full on-chain verification via OxaPay happens in verifyAndConfirmByTxHash()
    if (!validateTransactionHashFormat(transactionHash, payment.network)) {
      logger.warn(
        "[Crypto Payments API] Invalid transaction hash format for network",
        {
          paymentId: redact.paymentId(id),
          ip: redact.ip(ip),
          userId: redact.userId(user.id),
          network: payment.network,
          txHashLength: transactionHash.length,
        },
      );
      return NextResponse.json(
        {
          error: `Invalid transaction hash format for ${payment.network} network`,
        },
        { status: 400 },
      );
    }

    logger.info("[Crypto Payments API] Processing manual confirmation", {
      paymentId: redact.paymentId(id),
      network: payment.network,
      userId: redact.userId(user.id),
      organizationId: redact.orgId(user.organization_id),
      ip: redact.ip(ip),
    });

    const result = await cryptoPaymentsService.verifyAndConfirmByTxHash(
      id,
      transactionHash,
    );

    if (result.success) {
      logger.info("[Crypto Payments API] Manual confirmation successful", {
        paymentId: redact.paymentId(id),
        userId: redact.userId(user.id),
        ip: redact.ip(ip),
      });
      return NextResponse.json({
        success: true,
        message: "Payment confirmed successfully",
        status: "confirmed",
      });
    }

    logger.warn("[Crypto Payments API] Manual confirmation failed", {
      paymentId: redact.paymentId(id),
      userId: redact.userId(user.id),
      ip: redact.ip(ip),
      reason: result.message,
    });

    return NextResponse.json(
      {
        success: false,
        message: "Unable to confirm payment",
        status: payment.status,
      },
      { status: 400 },
    );
  } catch (error) {
    logger.error("[Crypto Payments API] Confirm payment error", {
      ip: redact.ip(ip),
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Failed to process confirmation" },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(
  handleConfirmPayment,
  RateLimitPresets.STRICT,
);
