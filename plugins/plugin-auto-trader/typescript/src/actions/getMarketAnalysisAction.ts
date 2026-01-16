/**
 * Get Market Analysis Action
 *
 * Provides market analysis using TokenResolver to fetch trending tokens
 * and display market data.
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { TokenResolverService } from "../services/TokenResolverService.ts";
import type { TokenValidationService } from "../services/TokenValidationService.ts";

export const getMarketAnalysisAction: Action = {
  name: "GET_MARKET_ANALYSIS",
  similes: ["MARKET_ANALYSIS", "ANALYZE_MARKET", "MARKET_OVERVIEW", "TRENDING_TOKENS"],
  description: "Get market analysis and trending token information",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    const keywords = [
      "analyze",
      "analysis",
      "market",
      "trending",
      "outlook",
      "sentiment",
      "overview",
    ];
    return keywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const resolver = runtime.getService("TokenResolverService") as TokenResolverService | undefined;
    const validator = runtime.getService("TokenValidationService") as
      | TokenValidationService
      | undefined;

    if (!resolver) {
      callback?.({
        text: "❌ Market data service not available. Configure BIRDEYE_API_KEY.",
      });
      return undefined;
    }

    // Check if user asked about a specific token
    const text = message.content.text || "";
    const tokenMatch = text.match(/\b([A-Z]{2,10})\b/);

    let response = "🔍 **Market Analysis**\n\n";

    // If specific token mentioned, analyze it
    if (tokenMatch && tokenMatch[1] !== "USDC" && tokenMatch[1] !== "USD") {
      const tokenInfo = await resolver.resolve(tokenMatch[1]);

      if (tokenInfo) {
        response += `**${tokenInfo.symbol} (${tokenInfo.name})**\n`;
        response += `• Address: \`${tokenInfo.address.slice(0, 12)}...\`\n`;
        response += `• Price: $${tokenInfo.price?.toFixed(6) || "N/A"}\n`;
        response += `• 24h Volume: $${tokenInfo.volume24h?.toLocaleString() || "N/A"}\n`;
        response += `• Liquidity: $${tokenInfo.liquidity?.toLocaleString() || "N/A"}\n\n`;

        // Validate token
        if (validator) {
          const validation = await validator.validateToken(tokenInfo.address);
          if (validation.isValid) {
            response += "✅ **Safety Check: PASSED**\n";
          } else {
            response += "❌ **Safety Check: FAILED**\n";
            validation.rejectionReasons.forEach((r) => {
              response += `• ${r}\n`;
            });
          }
          if (validation.warnings.length > 0) {
            response += "\n⚠️ **Warnings:**\n";
            validation.warnings.slice(0, 3).forEach((w) => {
              response += `• ${w}\n`;
            });
          }
        }
        response += "\n---\n\n";
      }
    }

    // Get trending tokens
    const trending = await resolver.getTrendingTokens(10);

    if (trending.length > 0) {
      response += "**📈 Top Trending Tokens (by 24h Volume)**\n\n";

      trending.slice(0, 10).forEach((token, i) => {
        const vol = token.volume24h ? `$${(token.volume24h / 1e6).toFixed(1)}M` : "N/A";
        const liq = token.liquidity ? `$${(token.liquidity / 1e6).toFixed(1)}M` : "N/A";
        response += `${i + 1}. **${token.symbol}** - $${token.price?.toFixed(6) || "N/A"} | Vol: ${vol} | Liq: ${liq}\n`;
      });

      response += `\n---\n\n`;
      response += `**💡 Tips:**\n`;
      response += `• High volume with high liquidity = safer trades\n`;
      response += `• Use "Buy [amount] SOL of [TOKEN]" to trade\n`;
      response += `• Start trading with "Start trading with LLM strategy"\n`;
    } else {
      response += "⚠️ Could not fetch trending tokens. Check BIRDEYE_API_KEY.\n";
    }

    callback?.({ text: response });
    return undefined;
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "Give me a market analysis" } },
      {
        name: "{{agentName}}",
        content: { text: "Here is the current market overview..." },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Analyze BONK for me" } },
      { name: "{{agentName}}", content: { text: "Let me analyze BONK..." } },
    ],
  ],
};
