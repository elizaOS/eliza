/**
 * POST /api/crypto/direct-payments/:id/attach-tx
 *
 * Records the on-chain transaction hash for a pending direct payment the
 * instant the user's wallet returns it — BEFORE the on-chain verify step
 * runs. This is the durability anchor: once the hash is attached, a tab
 * close, network drop, or confirm failure can no longer orphan the
 * payment, because the cron auto-confirm path picks it up by hash.
 *
 * Idempotent: re-posting the same hash returns the same record.
 */

import { Hono } from "hono";
import { z } from "zod";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { directWalletPaymentsService } from "@/lib/services/direct-wallet-payments";
import { logger, redact } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const evmTxHashRegex = /^0x[a-fA-F0-9]{64}$/;
const solanaTxHashRegex = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

const bodySchema = z.object({
  transactionHash: z
    .string()
    .min(1)
    .refine(
      (h) => evmTxHashRegex.test(h) || solanaTxHashRegex.test(h),
      "Invalid transaction hash for EVM or Solana network",
    ),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";
    const body = await c.req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: parsed.error.flatten().fieldErrors,
        },
        400,
      );
    }

    const result = await directWalletPaymentsService.attachTransaction({
      paymentId: id,
      txHash: parsed.data.transactionHash,
      userId: user.id,
    });

    return c.json({
      success: true,
      paymentId: result.payment.id,
      status: result.payment.status,
      txHash: result.payment.transaction_hash,
      alreadyAttached: result.alreadyAttached,
    });
  } catch (error) {
    logger.warn("[direct-payments/attach-tx] failed", {
      paymentId: redact.paymentId(c.req.param("id") ?? ""),
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
