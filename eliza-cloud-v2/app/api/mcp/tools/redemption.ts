/**
 * Token redemption tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { twapPriceOracle } from "@/lib/services/twap-price-oracle";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerRedemptionTools(server: McpServer): void {
  server.registerTool(
    "get_redemption_balance",
    {
      description: "Get redeemable token balance. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const balance = await redeemableEarningsService.getBalance(user.id);

        return jsonResponse({
          success: true,
          balance,
          userId: user.id,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to get balance",
        );
      }
    },
  );

  server.registerTool(
    "get_redemption_quote",
    {
      description: "Get token redemption quote. FREE tool.",
      inputSchema: {
        pointsAmount: z
          .number()
          .int()
          .min(100)
          .max(100000)
          .describe("Points to redeem"),
        network: z
          .enum(["ethereum", "base", "bnb", "solana"])
          .describe("Payout network"),
      },
    },
    async ({ pointsAmount, network }) => {
      try {
        const { user } = getAuthContext();
        const quoteResult = await twapPriceOracle.getRedemptionQuote(
          network,
          pointsAmount,
          user.id,
        );
        if (!quoteResult.success) {
          return errorResponse(
            quoteResult.error || "Failed to get redemption quote",
          );
        }
        return jsonResponse({ success: true, quote: quoteResult.quote });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get redemption quote",
        );
      }
    },
  );
}
