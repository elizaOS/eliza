/**
 * /api/admin/buy-eliza/quote
 *
 * Returns a quote (USD → ELIZA on the requested network) plus the on-chain
 * receive address an admin should send funds to in order to top up the
 * treasury hot wallet. Quote-only — does not execute trades.
 */

import { Hono } from "hono";
import { z } from "zod";

import { ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  elizaTokenPriceService,
  type SupportedNetwork,
} from "@/lib/services/eliza-token-price";
import { getHotWalletAddresses } from "@/lib/services/payout-status";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const QuoteSchema = z.object({
  network: z.enum(["ethereum", "base", "bnb", "solana"]),
  usdAmount: z.number().positive().max(1_000_000),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const { user } = await requireAdmin(c);

  const body = await c.req.json().catch(() => null);
  const parsed = QuoteSchema.safeParse(body);
  if (!parsed.success) {
    throw ValidationError("Invalid request", { issues: parsed.error.format() });
  }
  const { network, usdAmount } = parsed.data;

  const priceQuote = await elizaTokenPriceService.getPrice(
    network as SupportedNetwork,
  );
  const elizaAmount = usdAmount / priceQuote.priceUsd;

  const wallets = getHotWalletAddresses();
  const receiveAddress = network === "solana" ? wallets.solana : wallets.evm;

  if (!receiveAddress) {
    return c.json(
      {
        success: false,
        error: `Treasury hot wallet for ${network} is not configured. Set ${network === "solana" ? "SOLANA_PAYOUT_PRIVATE_KEY" : "EVM_PAYOUT_PRIVATE_KEY"}.`,
      },
      503,
    );
  }

  logger.info("[admin/buy-eliza] quote generated", {
    adminUserId: user.id,
    network,
    usdAmount,
    priceUsd: priceQuote.priceUsd,
    elizaAmount,
  });

  return c.json({
    success: true,
    data: {
      network,
      usdAmount,
      priceUsd: priceQuote.priceUsd,
      elizaAmount,
      priceSource: priceQuote.source,
      expiresAt: priceQuote.expiresAt,
      treasury: {
        receiveAddress,
        note: "Send USDC/USDT or ELIZA to this address. Use the recorded-purchase endpoint to log the tx hash.",
      },
    },
  });
});

export default app;
