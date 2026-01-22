/**
 * Start Trading Action
 *
 * Starts automated trading with a specified strategy.
 * Supports ANY Solana token via dynamic resolution.
 * LLM strategy auto-discovers trending tokens.
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
import type { AutoTradingManager } from "../services/AutoTradingManager.ts";
import type { TokenResolverService } from "../services/TokenResolverService.ts";

/** Map user-friendly strategy names to internal strategy IDs */
const STRATEGY_MAP: Record<string, string> = {
  llm: "llm",
  ai: "llm",
  smart: "llm",
  intelligent: "llm",
  momentum: "momentum-breakout-v1",
  breakout: "momentum-breakout-v1",
  "mean reversion": "mean-reversion",
  "mean-reversion": "mean-reversion",
  reversion: "mean-reversion",
  rules: "rule-based",
  "rule-based": "rule-based",
  technical: "rule-based",
  random: "random-v1",
};

/** Extract token mentions from text - any word that could be a token symbol */
async function extractTokens(
  text: string,
  resolver: TokenResolverService | undefined,
): Promise<string[]> {
  const resolved: string[] = [];

  // Check for direct Solana addresses
  const addressMatches = text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  for (const match of addressMatches) {
    resolved.push(match[0]);
  }

  // Check for token mentions in text
  // Pattern: "trade BONK", "on WIF and POPCAT", "tokens: PEPE, DOGE"
  const tokenPatterns = [
    /(?:trade|on|tokens?:?|with)\s+([A-Z0-9]+(?:\s*,?\s*[A-Z0-9]+)*)/gi,
    /(?:trade|buy|sell)\s+([A-Z][A-Z0-9]{2,10})/gi,
  ];

  const potentialSymbols = new Set<string>();
  for (const pattern of tokenPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const symbols = match[1].split(/[\s,]+/).filter((s) => s.length >= 2 && s.length <= 12);
      for (const s of symbols) {
        potentialSymbols.add(s.toUpperCase());
      }
    }
  }

  // Common tokens mentioned by name
  const namedTokens: Record<string, string> = {
    bonk: "BONK",
    wif: "WIF",
    dogwifhat: "WIF",
    popcat: "POPCAT",
    jupiter: "JUP",
    raydium: "RAY",
    pepe: "PEPE",
    solana: "SOL",
  };

  for (const [name, symbol] of Object.entries(namedTokens)) {
    if (text.includes(name)) {
      potentialSymbols.add(symbol);
    }
  }

  // Resolve all symbols
  if (resolver && potentialSymbols.size > 0) {
    for (const symbol of potentialSymbols) {
      const tokenInfo = await resolver.resolve(symbol);
      if (tokenInfo) {
        resolved.push(tokenInfo.address);
      }
    }
  }

  return resolved;
}

export const startTradingAction: Action = {
  name: "START_TRADING",
  similes: ["BEGIN_TRADING", "START_AUTO_TRADING", "ENABLE_TRADING", "TURN_ON_TRADING"],
  description: "Start automated trading with a specified strategy. Supports ANY Solana token.",

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Start trading with the LLM strategy" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "🚀 Auto-trading started!\nStrategy: LLM Trading Strategy\nMode: Analyzing trending tokens from Birdeye",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Start momentum trading on BONK with $500 max position",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "🚀 Auto-trading started!\nStrategy: Momentum Breakout\nTokens: BONK",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Trade PEPE and DOGE using AI strategy" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "🚀 Auto-trading started!\nStrategy: LLM Trading Strategy\nTokens: PEPE, DOGE",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Begin trading EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
        },
      },
      {
        name: "{{agentName}}",
        content: { text: "🚀 Auto-trading started!\nTokens: WIF (EKpQGSJ...)" },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = (message.content.text || "").toLowerCase();
    return text.includes("start") || text.includes("begin") || text.includes("enable");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const autoTradingManager = runtime.getService("AutoTradingManager") as
      | AutoTradingManager
      | undefined;
    const resolver = runtime.getService("TokenResolverService") as TokenResolverService | undefined;

    if (!autoTradingManager) {
      callback?.({
        text: "❌ AutoTradingManager not found. Ensure plugin is loaded.",
        action: "START_TRADING",
      });
      return undefined;
    }

    // Check if already trading
    const currentStatus = autoTradingManager.getStatus();
    if (currentStatus.isTrading) {
      callback?.({
        text: `⚠️ Trading is already active with the ${currentStatus.strategy} strategy.\n\nTo change strategies, first stop trading with "Stop trading" and then start again.`,
        action: "START_TRADING",
      });
      return undefined;
    }

    const text = (message.content.text || "").toLowerCase();

    // Extract strategy
    let strategyId = "llm";
    let strategyName = "LLM Trading Strategy";

    for (const [keyword, id] of Object.entries(STRATEGY_MAP)) {
      if (text.includes(keyword)) {
        strategyId = id;
        break;
      }
    }

    const strategies = autoTradingManager.getStrategies();
    const selectedStrategy = strategies.find((s) => s.id === strategyId);
    if (selectedStrategy) {
      strategyName = selectedStrategy.name;
    }

    // Extract tokens dynamically
    let tokens = await extractTokens(message.content.text || "", resolver);

    // Check for "top X trending" pattern
    const topMatch = text.match(/top (\d+) (?:trending|meme|coins?)/);
    if (topMatch && resolver) {
      const count = parseInt(topMatch[1], 10);
      const trending = await resolver.getTrendingTokens(count);
      tokens = trending.map((t) => t.address);
    }

    // For LLM strategy with no tokens, use 'auto' for dynamic discovery
    if (tokens.length === 0 && strategyId === "llm") {
      tokens = ["auto"];
    }

    // Default to fetching trending tokens for other strategies too
    if (tokens.length === 0 && resolver) {
      const trending = await resolver.getTrendingTokens(3);
      tokens = trending.map((t) => t.address);
    }

    // If still no tokens and no resolver, fail gracefully
    if (tokens.length === 0) {
      callback?.({
        text: '❌ No tokens specified and unable to fetch trending tokens.\n\nPlease specify tokens to trade (e.g., "start trading BONK, WIF") or configure BIRDEYE_API_KEY.',
        action: "START_TRADING",
      });
      return undefined;
    }

    // Extract position size
    let maxPositionSize = 0.1; // default 10%
    const percentMatch = text.match(/(\d+)%?\s*(?:of\s+)?(?:portfolio|position)/);
    if (percentMatch) {
      maxPositionSize = parseInt(percentMatch[1], 10) / 100;
    }

    const amountMatch = text.match(/\$(\d+)/);
    if (amountMatch) {
      maxPositionSize = Math.min(parseInt(amountMatch[1], 10) / 1000, 0.25);
    }

    // Extract risk parameters
    let stopLossPercent = Number(runtime.getSetting("STOP_LOSS_PERCENT")) || 5;
    let takeProfitPercent = Number(runtime.getSetting("TAKE_PROFIT_PERCENT")) || 15;

    const slMatch = text.match(/stop\s*loss\s*(?:at\s*)?(\d+)%?/);
    if (slMatch) stopLossPercent = parseInt(slMatch[1], 10);

    const tpMatch = text.match(/take\s*profit\s*(?:at\s*)?(\d+)%?/);
    if (tpMatch) takeProfitPercent = parseInt(tpMatch[1], 10);

    // Extract interval
    let intervalMs = Number(runtime.getSetting("TRADING_INTERVAL_MS")) || 60000;
    const intervalMatch = text.match(/every\s*(\d+)\s*(minute|min|second|sec|hour|hr)/);
    if (intervalMatch) {
      const value = parseInt(intervalMatch[1], 10);
      const unit = intervalMatch[2];
      if (unit.startsWith("sec")) intervalMs = value * 1000;
      else if (unit.startsWith("min")) intervalMs = value * 60 * 1000;
      else if (unit.startsWith("hour") || unit.startsWith("hr"))
        intervalMs = value * 60 * 60 * 1000;
    }

    const maxDailyLoss = Number(runtime.getSetting("MAX_DAILY_LOSS_USD")) || 500;

    // Start trading
    await autoTradingManager.startTrading({
      strategy: strategyId,
      tokens,
      maxPositionSize,
      intervalMs,
      stopLossPercent,
      takeProfitPercent,
      maxDailyLoss,
    });

    // Format token names for response
    let tokenNames: string;
    if (tokens[0] === "auto") {
      tokenNames = "Auto-discovered trending tokens";
    } else if (resolver) {
      const names = await Promise.all(
        tokens.map(async (addr) => {
          const info = await resolver.resolveByAddress(addr);
          return info?.symbol || `${addr.slice(0, 8)}...`;
        }),
      );
      tokenNames = names.join(", ");
    } else {
      tokenNames = tokens.map((t) => `${t.slice(0, 8)}...`).join(", ");
    }

    const tradingMode = runtime.getSetting("TRADING_MODE") || "paper";
    const modeWarning =
      tradingMode === "live"
        ? "\n\n⚠️ **LIVE TRADING MODE** - Real funds at risk!"
        : "\n\n📝 Paper trading mode - No real funds used.";

    const response = `🚀 **Auto-trading started!**

**Strategy:** ${strategyName}
**Tokens:** ${tokenNames}
**Max position size:** ${(maxPositionSize * 100).toFixed(0)}% of portfolio
**Stop loss:** ${stopLossPercent}%
**Take profit:** ${takeProfitPercent}%
**Trading interval:** ${intervalMs / 1000}s
**Max daily loss:** $${maxDailyLoss}${modeWarning}

Use "Stop trading" to stop, or "Check portfolio" to see positions.`;

    callback?.({ text: response, action: "START_TRADING" });
    logger.info(`[startTradingAction] Started: ${strategyId}, tokens: ${tokenNames}`);
    return undefined;
  },
};
