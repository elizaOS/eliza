/**
 * GET /api/v1/redemptions/status — payout system status.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { payoutStatusService } from "@/lib/services/payout-status";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.options(
  "/",
  (c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-App-Id",
      },
    }),
);

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const status = await payoutStatusService.getStatus();

    const availableNetworks = status.networks
      .filter((n) => n.status === "operational" || n.status === "low_balance")
      .map((n) => n.network);

    const unavailableNetworks = status.networks
      .filter((n) => n.status === "no_balance" || n.status === "not_configured")
      .map((n) => n.network);

    const canRedeem = availableNetworks.length > 0;
    const evmNetwork = status.networks.find(
      (n) => n.network === "base" || n.network === "bnb" || n.network === "ethereum",
    );
    const solanaNetwork = status.networks.find((n) => n.network === "solana");

    let message: string;
    if (!canRedeem) {
      message =
        "Token redemption is temporarily unavailable. Our team is working to restore service. Please check back soon.";
    } else if (unavailableNetworks.length > 0) {
      message = `Token redemption is available on: ${availableNetworks.join(", ")}. Some networks (${unavailableNetworks.join(", ")}) are temporarily unavailable.`;
    } else {
      message = "All payout networks are operational.";
    }

    return c.json({
      success: true,
      operational: status.operational,
      canRedeem,
      message,
      availableNetworks,
      unavailableNetworks,
      wallets: {
        evm: {
          configured: Boolean(evmNetwork?.configured),
          address: evmNetwork?.walletAddress ?? undefined,
        },
        solana: {
          configured: Boolean(solanaNetwork?.configured),
          address: solanaNetwork?.walletAddress ?? undefined,
        },
      },
      networks: status.networks.map((n) => ({
        network: n.network,
        available: n.status === "operational" || n.status === "low_balance",
        status: n.status,
        message: n.message,
        balance: n.balance,
        ...(n.hasBalance && { balanceAvailable: n.balance > 0 }),
      })),
      warnings: status.warnings.filter((w) => !w.includes("balance")),
      lastChecked: status.lastChecked.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
