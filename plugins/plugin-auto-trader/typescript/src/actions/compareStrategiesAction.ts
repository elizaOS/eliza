/**
 * Compare Strategies Action
 *
 * Lists available strategies and their characteristics.
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { AutoTradingManager } from "../services/AutoTradingManager.ts";

const STRATEGY_DETAILS: Record<string, { description: string; bestFor: string; risk: string }> = {
  llm: {
    description: "AI-powered analysis of trending tokens using language models",
    bestFor: "Dynamic markets, trending tokens, meme coins",
    risk: "Medium - AI decisions can be unpredictable",
  },
  "momentum-breakout-v1": {
    description: "Technical analysis detecting price breakouts with momentum indicators",
    bestFor: "Volatile markets with clear trends",
    risk: "Medium-High - Can get caught in false breakouts",
  },
  "mean-reversion": {
    description: "Trades based on price deviation from moving averages",
    bestFor: "Range-bound markets, stable tokens",
    risk: "Low-Medium - May miss strong trends",
  },
  "rule-based": {
    description: "Configurable technical indicator rules (RSI, SMA, MACD)",
    bestFor: "Systematic traders who want control over entry/exit rules",
    risk: "Depends on configuration",
  },
  "random-v1": {
    description: "Random trade decisions - for testing purposes only",
    bestFor: "Testing infrastructure and paper trading",
    risk: "High - Not a real strategy",
  },
};

export const compareStrategiesAction: Action = {
  name: "COMPARE_STRATEGIES",
  similes: ["STRATEGY_COMPARISON", "LIST_STRATEGIES", "WHICH_STRATEGY", "BEST_STRATEGY"],
  description: "Compare available trading strategies",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return ["compare", "strategies", "which strategy", "best strategy", "list strategy"].some(
      (kw) => text.includes(kw),
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const tradingManager = runtime.getService("AutoTradingManager") as
      | AutoTradingManager
      | undefined;
    const strategies = tradingManager?.getStrategies() || [];

    let response = `📊 **Trading Strategy Comparison**\n\n`;

    strategies.forEach((strategy, index) => {
      const details = STRATEGY_DETAILS[strategy.id] || {
        description: strategy.description || "No description available",
        bestFor: "General trading",
        risk: "Unknown",
      };

      const emoji =
        strategy.id === "llm"
          ? "🤖"
          : strategy.id.includes("momentum")
            ? "📈"
            : strategy.id.includes("reversion")
              ? "↔️"
              : strategy.id.includes("rule")
                ? "📋"
                : "🎲";

      response += `**${index + 1}. ${emoji} ${strategy.name}** (\`${strategy.id}\`)
• ${details.description}
• **Best for:** ${details.bestFor}
• **Risk level:** ${details.risk}

`;
    });

    response += `---

**🏆 Recommended Strategy:** LLM Strategy
• Uses AI to analyze trending tokens from Birdeye
• Includes automatic stop-loss and take-profit
• Pre-filters honeypots and scam tokens

**How to Start:**
\`\`\`
"Start trading with LLM strategy"
"Begin momentum trading"
"Start paper trading with rule-based strategy"
\`\`\`

Would you like to start trading with a specific strategy?`;

    callback?.({ text: response });
    return undefined;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Compare the different trading strategies" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Here is a comparison of available strategies..." },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Which strategy is best?" } },
      {
        name: "{{agentName}}",
        content: { text: "Let me compare the strategies for you..." },
      },
    ],
  ],
};
