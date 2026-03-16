/**
 * Execute Live Trade Action
 *
 * Executes token swaps on Solana via Jupiter DEX.
 * Supports ANY token - resolves symbols dynamically via Birdeye API.
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { KNOWN_TOKENS, type SwapService } from "../services/SwapService.ts";
import type { TokenResolverService } from "../services/TokenResolverService.ts";
import type { TokenValidationService } from "../services/TokenValidationService.ts";

const TRADE_KEYWORDS = [
  "live trade",
  "real trade",
  "execute",
  "place order",
  "buy",
  "sell",
  "swap",
  "trade",
  "purchase",
  "exchange",
];
const SIMULATION_KEYWORDS = ["backtest", "simulation", "simulate", "paper"];

/** Parse trade parameters from message text */
async function parseTradeParams(
  text: string,
  resolver: TokenResolverService | undefined,
): Promise<{
  isSell: boolean;
  amount: number;
  tokenSymbol: string;
  tokenAddress: string | null;
}> {
  const isSell = text.includes("sell");

  // Extract amount
  const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:sol|usd)?/i);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

  // Extract token - could be symbol, name, or address
  // Patterns: "buy BONK", "sell 100 PEPE", "swap for WIF", "trade into POPCAT"
  let tokenQuery: string | null = null;

  // Check for token after action words
  const tokenPatterns = [
    /(?:buy|purchase|get|acquire)\s+(?:\d+(?:\.\d+)?\s*(?:sol|usd)?\s+(?:worth\s+)?(?:of\s+)?)?(\w+)/i,
    /(?:sell)\s+(?:\d+(?:\.\d+)?\s+)?(\w+)/i,
    /(?:swap|trade|exchange)\s+(?:for|into|to)\s+(\w+)/i,
    /(?:worth of|for|into)\s+(\w+)/i,
  ];

  for (const pattern of tokenPatterns) {
    const match = text.match(pattern);
    if (match?.[1] && !["sol", "usd", "usdc", "dollars"].includes(match[1].toLowerCase())) {
      tokenQuery = match[1];
      break;
    }
  }

  // Check for Solana address directly in text
  const addressMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (addressMatch) {
    const address = addressMatch[0];
    if (resolver) {
      const tokenInfo = await resolver.resolveByAddress(address);
      return {
        isSell,
        amount,
        tokenSymbol: tokenInfo?.symbol || `${address.slice(0, 8)}...`,
        tokenAddress: address,
      };
    }
    return {
      isSell,
      amount,
      tokenSymbol: `${address.slice(0, 8)}...`,
      tokenAddress: address,
    };
  }

  // Resolve token symbol/name to address
  if (tokenQuery && resolver) {
    const tokenInfo = await resolver.resolve(tokenQuery);
    if (tokenInfo) {
      return {
        isSell,
        amount,
        tokenSymbol: tokenInfo.symbol,
        tokenAddress: tokenInfo.address,
      };
    }
  }

  return {
    isSell,
    amount,
    tokenSymbol: tokenQuery || "UNKNOWN",
    tokenAddress: null,
  };
}

/** Helper to send callback response */
function respond(callback: HandlerCallback | undefined, text: string): undefined {
  callback?.({ text });
  return undefined;
}

export const executeLiveTradeAction: Action = {
  name: "EXECUTE_LIVE_TRADE",
  similes: [
    "LIVE_TRADE",
    "REAL_TRADE",
    "EXECUTE_TRADE",
    "PLACE_ORDER",
    "MAKE_TRADE",
    "SWAP",
    "BUY_TOKEN",
    "SELL_TOKEN",
  ],
  description: "Execute a live token swap on Solana using Jupiter DEX. Supports ANY Solana token.",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    const hasTradeKeyword = TRADE_KEYWORDS.some((kw) => text.includes(kw));
    const isSimulation = SIMULATION_KEYWORDS.some((kw) => text.includes(kw));
    return hasTradeKeyword && !isSimulation;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const text = message.content.text?.toLowerCase() || "";

    // Get services
    const swapService = runtime.getService("SwapService") as SwapService | undefined;
    const resolver = runtime.getService("TokenResolverService") as TokenResolverService | undefined;

    // Parse trade parameters with dynamic resolution
    const { isSell, amount, tokenSymbol, tokenAddress } = await parseTradeParams(text, resolver);

    // Validate amount
    if (amount <= 0) {
      return respond(
        callback,
        `Please specify a valid amount. Example: "buy 0.5 SOL worth of ${tokenSymbol || "BONK"}"`,
      );
    }

    // Validate token
    if (!tokenAddress) {
      const suggestion = resolver
        ? `I couldn't find token "${tokenSymbol}". Try:\n• Using the full token name\n• Providing the contract address\n• Checking if the token exists on Solana`
        : `Unknown token "${tokenSymbol}". Please provide the token contract address directly.`;
      return respond(callback, suggestion);
    }

    // Check SwapService
    if (!swapService?.isReady()) {
      return respond(
        callback,
        "⚠️ **Trading Not Available**\n\nSwapService not configured. Set SOLANA_PRIVATE_KEY and ensure the plugin is loaded.",
      );
    }

    // Check trading mode
    const tradingMode = runtime.getSetting("TRADING_MODE");
    if (tradingMode !== "live") {
      return respond(
        callback,
        `⚠️ **Paper Trading Mode**\n\nYour trade would be: ${isSell ? "SELL" : "BUY"} ${amount} ${isSell ? tokenSymbol : "SOL"} → ${isSell ? "SOL" : tokenSymbol}\n\nSet TRADING_MODE=live to enable real trades.`,
      );
    }

    // Validate token safety for buys
    if (!isSell && tokenAddress !== KNOWN_TOKENS.SOL) {
      const validationService = runtime.getService("TokenValidationService") as
        | TokenValidationService
        | undefined;
      if (validationService) {
        const validation = await validationService.validateToken(tokenAddress);
        if (!validation.isValid) {
          return respond(
            callback,
            `❌ **Token Validation Failed**\n\n${tokenSymbol} (${tokenAddress.slice(0, 8)}...) failed safety checks:\n${validation.rejectionReasons.map((r) => `• ${r}`).join("\n")}\n\n⚠️ Trading this token is not recommended.`,
          );
        }
        if (validation.warnings.length > 0) {
          logger.warn(
            `[executeLiveTradeAction] Token warnings for ${tokenSymbol}: ${validation.warnings.join(", ")}`,
          );
        }
      }
    }

    const _walletAddress = swapService.getWalletAddress();
    logger.info(
      `[executeLiveTradeAction] ${isSell ? "SELL" : "BUY"}: ${amount} ${tokenSymbol} (${tokenAddress.slice(0, 12)}...)`,
    );

    // Execute trade
    if (isSell) {
      const balance = await swapService.getTokenBalance(tokenAddress);
      if (balance < amount) {
        return respond(
          callback,
          `❌ **Insufficient Balance**\n\nNeed: ${amount} ${tokenSymbol}\nHave: ${balance.toFixed(6)} ${tokenSymbol}`,
        );
      }

      const result = await swapService.sell(tokenAddress, amount);
      return respond(
        callback,
        result.success
          ? `✅ **Sold ${tokenSymbol}**\n\n**Spent:** ${result.inputAmount} ${tokenSymbol}\n**Received:** ${result.outputAmount} SOL\n**Impact:** ${result.priceImpact}%\n\n[View tx](${result.explorerUrl})`
          : `❌ **Sell Failed:** ${result.error}`,
      );
    }

    // BUY
    const balances = await swapService.getWalletBalances();
    if (balances.solBalance < amount) {
      return respond(
        callback,
        `❌ **Insufficient SOL**\n\nNeed: ${amount} SOL\nHave: ${balances.solBalance.toFixed(4)} SOL`,
      );
    }

    const result = await swapService.buy(tokenAddress, amount);
    return respond(
      callback,
      result.success
        ? `✅ **Bought ${tokenSymbol}**\n\n**Spent:** ${result.inputAmount} SOL\n**Received:** ${result.outputAmount} ${tokenSymbol}\n**Impact:** ${result.priceImpact}%\n\n[View tx](${result.explorerUrl})`
        : `❌ **Buy Failed:** ${result.error}`,
    );
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "Buy 0.5 SOL worth of BONK" } },
      {
        name: "{{agentName}}",
        content: {
          text: "✅ **Bought BONK**\n\n**Spent:** 0.5 SOL\n**Received:** 1,234,567 BONK",
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Sell 1000000 WIF" } },
      {
        name: "{{agentName}}",
        content: {
          text: "✅ **Sold WIF**\n\n**Spent:** 1,000,000 WIF\n**Received:** 0.4 SOL",
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Buy some PEPE with 1 SOL" } },
      {
        name: "{{agentName}}",
        content: {
          text: "✅ **Bought PEPE**\n\n**Spent:** 1 SOL\n**Received:** 50,000 PEPE",
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Swap 2 SOL for dogwifhat" } },
      {
        name: "{{agentName}}",
        content: {
          text: "✅ **Bought WIF**\n\n**Spent:** 2 SOL\n**Received:** 85.5 WIF",
        },
      },
    ],
  ],
};
