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
import type { SwapService } from "../services/SwapService.ts";

export const checkPortfolioAction: Action = {
  name: "CHECK_PORTFOLIO",
  similes: [
    "PORTFOLIO_CHECK",
    "VIEW_PORTFOLIO",
    "SHOW_HOLDINGS",
    "LIST_POSITIONS",
    "WALLET_BALANCE",
    "CHECK_BALANCE",
    "MY_PORTFOLIO",
    "MY_HOLDINGS",
    "MY_BALANCE",
    "TRADING_STATUS",
    "CHECK_TRADING",
  ],
  description:
    "Check current portfolio status including holdings, positions, and trading performance",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    const portfolioKeywords = [
      "portfolio",
      "balance",
      "holdings",
      "positions",
      "wallet",
      "check",
      "show",
      "view",
      "list",
      "status",
      "trading",
      "performance",
    ];

    return portfolioKeywords.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    // Get services
    const tradingManager = runtime.getService("AutoTradingManager") as
      | AutoTradingManager
      | undefined;
    const swapService = runtime.getService("SwapService") as SwapService | undefined;

    let walletSection = "";
    let tradingSection = "";
    let positionsSection = "";
    let performanceSection = "";

    // Get wallet balances
    if (swapService?.isReady()) {
      const balances = await swapService.getWalletBalances();
      const walletAddress = swapService.getWalletAddress();

      walletSection = `💼 **Wallet**
\`${walletAddress}\`

**SOL Balance:** ${balances.solBalance.toFixed(4)} SOL (~$${(balances.solBalance * 150).toFixed(2)})

${
  balances.tokens.length > 0
    ? `**Tokens:**\n${balances.tokens
        .filter((t) => t.uiAmount > 0)
        .slice(0, 10)
        .map((t) => `• ${t.mint.slice(0, 8)}...: ${t.uiAmount.toFixed(4)}`)
        .join("\n")}`
    : "**Tokens:** None"
}`;
    } else {
      walletSection = `💼 **Wallet**
⚠️ Wallet not configured. Set SOLANA_PRIVATE_KEY to enable trading.`;
    }

    // Get trading status
    if (tradingManager) {
      const status = tradingManager.getStatus();
      const recentTrades = tradingManager.getLatestTransactions(5);

      // Trading status
      tradingSection = `\n\n🤖 **Trading Status**
**Active:** ${status.isTrading ? "✅ Yes" : "❌ No"}
${status.strategy ? `**Strategy:** ${status.strategy}` : ""}`;

      // Open positions
      if (status.positions.length > 0) {
        positionsSection = `\n\n📊 **Open Positions** (${status.positions.length})
${status.positions
  .map((p) => {
    const pnl = (((p.currentPrice || p.entryPrice) - p.entryPrice) / p.entryPrice) * 100;
    const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";
    return `${pnlEmoji} **${p.tokenAddress.slice(0, 8)}...**
   Entry: $${p.entryPrice.toFixed(6)} | Current: $${(p.currentPrice || p.entryPrice).toFixed(6)}
   Amount: ${p.amount.toFixed(4)} | P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
  })
  .join("\n\n")}`;
      } else {
        positionsSection = "\n\n📊 **Open Positions:** None";
      }

      // Performance metrics
      const perf = status.performance;
      performanceSection = `\n\n📈 **Performance**
**Total P&L:** ${perf.totalPnL >= 0 ? "+" : ""}$${perf.totalPnL.toFixed(2)}
**Today's P&L:** ${perf.dailyPnL >= 0 ? "+" : ""}$${perf.dailyPnL.toFixed(2)}
**Win Rate:** ${(perf.winRate * 100).toFixed(1)}%
**Total Trades:** ${perf.totalTrades}`;

      // Recent trades
      if (recentTrades.length > 0) {
        performanceSection += `\n\n📜 **Recent Trades**
${recentTrades
  .slice(-5)
  .reverse()
  .map((t) => {
    const time = new Date(t.timestamp).toLocaleTimeString();
    const emoji = t.action === "BUY" ? "🟢" : "🔴";
    return `${emoji} ${t.action} ${t.quantity.toFixed(4)} ${t.token.slice(0, 8)}... @ $${t.price.toFixed(6)} (${time})`;
  })
  .join("\n")}`;
      }
    }

    const response = `${walletSection}${tradingSection}${positionsSection}${performanceSection}

---
*Last updated: ${new Date().toLocaleString()}*`;

    if (callback) {
      callback({
        text: response,
      });
    }

    logger.info("[checkPortfolioAction] Portfolio check completed");
    return undefined;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Check my portfolio",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "📊 **Portfolio Status**\n\n💼 **Wallet**\nSOL Balance: 10.5 SOL\n\n🤖 **Trading Status**\nActive: ✅ Yes\nStrategy: LLM Trading Strategy",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show trading status",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "🤖 **Trading Status**\nActive: ✅ Yes\nStrategy: Momentum Breakout\n\n📈 **Performance**\nTotal P&L: +$125.50\nWin Rate: 65%",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What are my positions?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "📊 **Open Positions** (2)\n🟢 BONK: +15.2%\n🔴 WIF: -3.1%",
        },
      },
    ],
  ],
};
