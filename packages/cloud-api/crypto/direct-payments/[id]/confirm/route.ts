/**
 * POST /api/crypto/direct-payments/:id/confirm
 * Confirms a wallet-native payment by verifying the submitted on-chain
 * transaction and crediting the authenticated user's organization.
 */

import { Hono } from "hono";
import { z } from "zod";
import { cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { directWalletPaymentsService } from "@/lib/services/direct-wallet-payments";
import { logger, redact } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const evmTxHashRegex = /^0x[a-fA-F0-9]{64}$/;
const solanaTxHashRegex = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

const confirmSchema = z.object({
  transactionHash: z.string().min(1),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const id = c.req.param("id") ?? "";
    const payment = await cryptoPaymentsRepository.findById(id);
    if (!payment) return c.json({ error: "Payment not found" }, 404);
    if (
      payment.organization_id !== user.organization_id ||
      payment.user_id !== user.id
    ) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const body = await c.req.json();
    const validation = confirmSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid transaction hash" }, 400);
    }

    const network = String(payment.metadata?.direct_network ?? "");
    const transactionHash = validation.data.transactionHash;
    const validHash =
      network === "solana"
        ? solanaTxHashRegex.test(transactionHash)
        : evmTxHashRegex.test(transactionHash);
    if (!validHash) {
      return c.json(
        {
          error: `Invalid transaction hash for ${network || "payment"} network`,
        },
        400,
      );
    }

    const result = await directWalletPaymentsService.confirmPayment(c.env, {
      paymentId: id,
      txHash: transactionHash,
      userId: user.id,
    });

    return c.json({
      success: true,
      status: "confirmed",
      alreadyConfirmed: result.alreadyConfirmed,
      paymentId: result.payment.id,
      creditsToAdd: result.payment.credits_to_add,
    });
  } catch (error) {
    logger.warn("[Direct Crypto Payments API] Confirm payment failed", {
      paymentId: redact.paymentId(c.req.param("id") ?? ""),
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
