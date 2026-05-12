/**
 * POST /api/crypto/payments/:id/confirm
 *
 * User-supplied transaction hash to confirm an OxaPay-tracked payment.
 * Format-validates the hash for the payment's network, then defers to
 * `cryptoPaymentsService.verifyAndConfirmByTxHash` for the on-chain
 * verification (status, confirmations, amount).
 */

import { Hono } from "hono";
import { z } from "zod";
import { cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { logger, redact } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ethereumTxHashRegex = /^0x[a-fA-F0-9]{64}$/;
const tronTxHashRegex = /^[A-Za-z0-9]{64}$/;
const solanaTxHashRegex = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

function validateTransactionHashFormat(hash: string, network: string): boolean {
  const n = network.toUpperCase();
  if (
    n.includes("ERC20") ||
    n.includes("BEP20") ||
    n.includes("POLYGON") ||
    n.includes("BASE") ||
    n.includes("ARB") ||
    n.includes("OP")
  ) {
    return ethereumTxHashRegex.test(hash);
  }
  if (n.includes("TRC20") || n.includes("TRON")) return tronTxHashRegex.test(hash);
  if (n.includes("SOL") || n.includes("SOLANA")) return solanaTxHashRegex.test(hash);
  return ethereumTxHashRegex.test(hash);
}

const confirmSchema = z.object({
  transactionHash: z.string().min(1, "Transaction hash is required"),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";

  try {
    const user = await requireUserWithOrg(c);
    const id = c.req.param("id") ?? "";

    const payment = await cryptoPaymentsRepository.findById(id);
    if (!payment) {
      logger.warn("[Crypto Payments API] Payment not found", {
        paymentId: redact.paymentId(id),
        ip: redact.ip(ip),
        userId: redact.userId(user.id),
      });
      return c.json({ error: "Payment not found" }, 404);
    }

    if (payment.organization_id !== user.organization_id) {
      logger.warn("[Crypto Payments API] Unauthorized confirmation attempt", {
        paymentId: redact.paymentId(id),
        ip: redact.ip(ip),
        userId: redact.userId(user.id),
        paymentOrg: redact.orgId(payment.organization_id),
        userOrg: redact.orgId(user.organization_id),
      });
      return c.json({ error: "Unauthorized" }, 403);
    }

    if (payment.status === "confirmed") {
      return c.json({
        success: true,
        message: "Payment already confirmed",
        status: payment.status,
      });
    }
    if (payment.status === "expired") {
      return c.json({ error: "Payment has expired" }, 400);
    }

    const body = await c.req.json();
    const validation = confirmSchema.safeParse(body);
    if (!validation.success) {
      logger.warn("[Crypto Payments API] Invalid confirmation request", {
        paymentId: redact.paymentId(id),
        ip: redact.ip(ip),
        userId: redact.userId(user.id),
        errors: validation.error.flatten().fieldErrors,
      });
      return c.json({ error: "Invalid transaction hash format" }, 400);
    }

    const { transactionHash } = validation.data;

    if (!validateTransactionHashFormat(transactionHash, payment.network)) {
      logger.warn("[Crypto Payments API] Invalid transaction hash format for network", {
        paymentId: redact.paymentId(id),
        ip: redact.ip(ip),
        userId: redact.userId(user.id),
        network: payment.network,
        txHashLength: transactionHash.length,
      });
      return c.json(
        { error: `Invalid transaction hash format for ${payment.network} network` },
        400,
      );
    }

    logger.info("[Crypto Payments API] Processing manual confirmation", {
      paymentId: redact.paymentId(id),
      network: payment.network,
      userId: redact.userId(user.id),
      organizationId: redact.orgId(user.organization_id),
      ip: redact.ip(ip),
    });

    const result = await cryptoPaymentsService.verifyAndConfirmByTxHash(id, transactionHash);

    if (result.success) {
      logger.info("[Crypto Payments API] Manual confirmation successful", {
        paymentId: redact.paymentId(id),
        userId: redact.userId(user.id),
        ip: redact.ip(ip),
      });
      return c.json({
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

    return c.json(
      { success: false, message: "Unable to confirm payment", status: payment.status },
      400,
    );
  } catch (error) {
    logger.error("[Crypto Payments API] Confirm payment error", {
      ip: redact.ip(ip),
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
});

export default app;
