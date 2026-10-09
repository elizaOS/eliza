/**
 * POST /api/crypto/direct-payments/:id/confirm
 * Confirms a wallet-native payment by verifying the submitted on-chain
 * transaction and crediting the authenticated user's organization.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { cryptoPaymentsRepository } from "@elizaos/cloud-shared/db/repositories/crypto-payments";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { directWalletPaymentsService } from "@elizaos/cloud-shared/lib/services/direct-wallet-payments";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger, redact } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const evmTxHashRegex = /^0x[a-fA-F0-9]{64}$/;
const solanaTxHashRegex = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

const confirmSchema = z.object({
  transactionHash: z.string().min(1),
  payerSignature: z.string().min(1),
});

const app = new Hono<AppEnv>();

app.post("/", moneyRateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";
    const payment = await cryptoPaymentsRepository.findById(id);
    if (!payment) return c.json({ error: "Payment not found" }, 404);
    if (
      payment.organization_id !== user.organization_id ||
      payment.user_id !== user.id
    ) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const validation = confirmSchema.safeParse(decodedBody.value);
    if (!validation.success) {
      return c.json(
        {
          error: "Invalid request",
          details: validation.error.flatten().fieldErrors,
        },
        400,
      );
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
      payerSignature: validation.data.payerSignature,
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
