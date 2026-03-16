import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { AutoTradingManager } from "../services/AutoTradingManager.ts";

const STRATEGY_INFO: Record<string, { type: string; bestFor: string; riskLevel: string }> = {
  llm: {
    type: "AI-driven analysis",
    bestFor: "Complex market analysis",
    riskLevel: "Variable",
  },
  "momentum-breakout-v1": {
    type: "Technical analysis",
    bestFor: "Trending markets",
    riskLevel: "Moderate",
  },
  "mean-reversion": {
    type: "Statistical",
    bestFor: "Range-bound markets",
    riskLevel: "Moderate",
  },
  "rule-based": {
    type: "Technical indicators",
    bestFor: "Systematic trading",
    riskLevel: "Low-Moderate",
  },
  "random-v1": {
    type: "Probabilistic",
    bestFor: "Baseline testing",
    riskLevel: "High",
  },
};

export const strategyProvider: Provider = {
  name: "STRATEGY",
  get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    const tradingManager = runtime.getService("AutoTradingManager") as
      | AutoTradingManager
      | undefined;

    if (!tradingManager) {
      return {
        text: "Strategy information unavailable - trading service not loaded.",
      };
    }

    const strategies = tradingManager.getStrategies();
    const status = tradingManager.getStatus();

    let text = `🎯 **Available Trading Strategies**\n\n`;

    for (const strategy of strategies) {
      const info = STRATEGY_INFO[strategy.id] || {
        type: "Custom",
        bestFor: "Various",
        riskLevel: "Variable",
      };
      const isActive = status.strategy === strategy.name;
      text += `**${strategy.name}** ${isActive ? "✅ Active" : ""}\n`;
      text += `• ID: \`${strategy.id}\`\n`;
      text += `• Type: ${info.type}\n`;
      text += `• Best for: ${info.bestFor}\n`;
      text += `• Risk: ${info.riskLevel}\n\n`;
    }

    text += `💡 **Quick Start:**\n`;
    text += `• "Start trading with LLM strategy"\n`;
    text += `• "Start momentum trading on BONK"\n`;
    text += `• "Run backtest with mean reversion"`;

    return { text };
  },
};
