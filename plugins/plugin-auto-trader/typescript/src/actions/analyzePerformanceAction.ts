/**
 * Analyze Performance Action
 *
 * Provides trading performance metrics from the AutoTradingManager.
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

export const analyzePerformanceAction: Action = {
  name: "ANALYZE_PERFORMANCE",
  similes: ["PERFORMANCE_ANALYSIS", "CHECK_PERFORMANCE", "TRADING_RESULTS", "SHOW_PERFORMANCE"],
  description: "Analyze trading performance and show metrics",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    const keywords = [
      "performance",
      "metrics",
      "results",
      "p&l",
      "pnl",
      "profit",
      "loss",
      "stats",
      "statistics",
    ];
    return keywords.some((kw) => text.includes(kw));
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

    if (!tradingManager) {
      callback?.({
        text: "❌ Trading manager not available. Please ensure the plugin is loaded.",
      });
      return;
    }

    const status = tradingManager.getStatus();
    const performance = status.performance;
    const transactions = tradingManager.getLatestTransactions(10);

    const isActive = status.isTrading ? "🟢 Active" : "🔴 Inactive";
    const pnlEmoji = performance.totalPnL >= 0 ? "📈" : "📉";
    const dailyPnlEmoji = performance.dailyPnL >= 0 ? "📈" : "📉";

    let response = `📊 **Trading Performance Analysis**

**Status:** ${isActive}
**Strategy:** ${status.strategy || "None"}

**Performance Metrics:**
• Total P&L: ${pnlEmoji} $${performance.totalPnL.toFixed(2)}
• Daily P&L: ${dailyPnlEmoji} $${performance.dailyPnL.toFixed(2)}
• Win Rate: ${(performance.winRate * 100).toFixed(1)}%
• Total Trades: ${performance.totalTrades}

**Open Positions:** ${status.positions.length}
`;

    if (status.positions.length > 0) {
      response += "\n**Current Positions:**\n";
      status.positions.forEach((pos) => {
        const pnl = pos.currentPrice
          ? (((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)
          : "0.00";
        const emoji = parseFloat(pnl) >= 0 ? "🟢" : "🔴";
        response += `${emoji} ${pos.tokenAddress.slice(0, 8)}... | Entry: $${pos.entryPrice.toFixed(4)} | P&L: ${pnl}%\n`;
      });
    }

    if (transactions.length > 0) {
      response += "\n**Recent Trades:**\n";
      transactions.slice(0, 5).forEach((tx) => {
        const emoji = tx.action === "BUY" ? "🟢 BUY" : "🔴 SELL";
        const time = new Date(tx.timestamp).toLocaleTimeString();
        response += `• ${emoji} ${tx.token.slice(0, 8)}... @ $${tx.price.toFixed(4)} (${time})\n`;
      });
    }

    response += `
**Analysis:**
${
  performance.totalPnL > 0
    ? "✅ Positive overall performance"
    : performance.totalPnL < 0
      ? "⚠️ Negative performance - consider reviewing strategy"
      : "➖ No realized P&L yet"
}
${
  performance.winRate > 0.5
    ? "🎯 Good win rate - more winning than losing trades"
    : performance.totalTrades > 0
      ? "⚠️ Low win rate - consider adjusting parameters"
      : ""
}

Use "Check portfolio" for more details or "Stop trading" to pause.`;

    callback?.({ text: response });
    return undefined;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "How did my trading strategy perform?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Let me analyze your trading performance..." },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Show me my P&L and statistics" } },
      {
        name: "{{agentName}}",
        content: { text: "Here are your performance metrics..." },
      },
    ],
  ],
};
