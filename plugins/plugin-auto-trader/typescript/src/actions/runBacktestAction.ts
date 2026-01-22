/**
 * Run Backtest Action
 *
 * Provides backtesting information. Note: Full backtesting requires
 * additional infrastructure (historical data service, simulation engine).
 * This action provides guidance on strategy testing.
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

export const runBacktestAction: Action = {
  name: "RUN_BACKTEST",
  similes: ["BACKTEST", "TEST_STRATEGY", "SIMULATE_TRADING"],
  description: "Get information about backtesting strategies",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return ["backtest", "simulation", "test strategy", "simulate"].some((kw) => text.includes(kw));
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

    const strategyList = strategies.map((s) => `• **${s.name}** (${s.id})`).join("\n");

    const response = `📊 **Backtesting Information**

**Available Strategies:**
${strategyList || "• No strategies loaded"}

**How to Test Strategies:**

1. **Paper Trading Mode** (Recommended)
   Start with paper trading to test strategies without real funds:
   \`\`\`
   "Start paper trading with LLM strategy"
   \`\`\`

2. **Monitor Performance**
   Track your paper trades over time:
   \`\`\`
   "Check portfolio" or "Show performance"
   \`\`\`

3. **Compare Results**
   Run different strategies and compare performance metrics.

**Settings:**
• Set \`TRADING_MODE=paper\` for simulated trading
• Use \`BIRDEYE_API_KEY\` for real market data
• Adjust \`STOP_LOSS_PERCENT\` and \`TAKE_PROFIT_PERCENT\`

**Note:** For production backtesting with historical data, consider using dedicated backtesting tools or running paper trading over extended periods.

Would you like to start paper trading with a specific strategy?`;

    callback?.({ text: response });
    return undefined;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Can you run a backtest for the LLM strategy?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Here is information about testing strategies..." },
      },
    ],
  ],
};
