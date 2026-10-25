/**
 * GET /api/v1/redemptions/status — payout system status.
 */

import type { RedemptionStatusResponse } from "@elizaos/cloud-sdk/redemption-contract";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { payoutStatusService } from "@elizaos/cloud-shared/lib/services/payout-status";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.options(
  "/",
  (_c) =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-API-Key, X-App-Id",
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
      (n) =>
        n.network === "base" || n.network === "bnb" || n.network === "ethereum",
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

    const response = {
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
    } satisfies RedemptionStatusResponse;

    return c.json(response);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
