import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { AutoTradingManager } from "../services/AutoTradingManager.ts";

export const tradingProvider: Provider = {
  name: "TRADING",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;
      if (!tradingManager) {
        return { text: "Trading services not available" };
      }

      const status = tradingManager.getStatus();
      const performance = status.performance;

      // Calculate unrealized P&L
      let unrealizedPnL = 0;
      status.positions.forEach((pos) => {
        if (pos.currentPrice && pos.currentPrice > 0) {
          const pnl = (pos.currentPrice - pos.entryPrice) * pos.amount;
          unrealizedPnL += pnl;
        }
      });

      const totalPnL = performance.totalPnL + unrealizedPnL;

      // Format comprehensive trading info
      const response = `📊 **Trading Dashboard**

🔴 **Status:** ${status.isTrading ? "ACTIVE 🟢" : "STOPPED 🔴"}
${status.strategy ? `📈 **Strategy:** ${status.strategy}` : ""}

💰 **Portfolio Performance:**
• Total P&L: ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} ${totalPnL >= 0 ? "📈" : "📉"}
• Today's P&L: ${performance.dailyPnL >= 0 ? "+" : ""}$${performance.dailyPnL.toFixed(2)}
• Unrealized P&L: ${unrealizedPnL >= 0 ? "+" : ""}$${unrealizedPnL.toFixed(2)}

📊 **Trading Statistics:**
• Total Trades: ${performance.totalTrades}
• Win Rate: ${(performance.winRate * 100).toFixed(1)}%
• Open Positions: ${status.positions.length}

${status.positions.length > 0 ? `\n📈 **Current Positions:**\n${formatPositions(status.positions)}` : ""}

${!status.isTrading ? '\n💡 Use "start trading" to begin automated trading.' : "\n⚡ Trading is active and monitoring markets."}`;

      return { text: response };
    } catch (error) {
      console.error("Error in tradingProvider:", error);
      return { text: "Unable to fetch trading information" };
    }
  },
};

interface PositionData {
  tokenAddress: string;
  amount: number;
  entryPrice: number;
  currentPrice?: number;
}

function formatPositions(positions: PositionData[]): string {
  return positions
    .map((pos) => {
      const currentPrice = pos.currentPrice ?? pos.entryPrice;
      const pnl = (currentPrice - pos.entryPrice) * pos.amount;
      const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      return `• ${pos.tokenAddress.slice(0, 8)}...: ${pos.amount.toFixed(4)} @ $${pos.entryPrice.toFixed(4)} (${pnlPercent.toFixed(2)}% | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`;
    })
    .join("\n");
}
