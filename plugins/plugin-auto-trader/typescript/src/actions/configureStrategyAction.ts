/**
 * Configure Strategy Action
 *
 * Allows users to configure trading strategy parameters.
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
import type { TokenValidationService } from "../services/TokenValidationService.ts";

export const configureStrategyAction: Action = {
  name: "CONFIGURE_STRATEGY",
  similes: ["CONFIG_STRATEGY", "SET_STRATEGY", "ADJUST_SETTINGS", "CHANGE_PARAMS"],
  description: "Configure trading strategy parameters",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return ["configure", "config", "set", "adjust", "parameter", "setting"].some((kw) =>
      text.includes(kw),
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const tradingManager = runtime.getService("AutoTradingManager") as
      | AutoTradingManager
      | undefined;
    const validationService = runtime.getService("TokenValidationService") as
      | TokenValidationService
      | undefined;

    if (!tradingManager) {
      callback?.({ text: "❌ Trading manager not available." });
      return;
    }

    const text = message.content.text?.toLowerCase() || "";
    const changes: string[] = [];

    // Parse stop loss
    const slMatch = text.match(/stop\s*loss\s*(?:to\s*)?(\d+)%?/i);
    if (slMatch) {
      const value = parseInt(slMatch[1], 10);
      runtime.setSetting("STOP_LOSS_PERCENT", String(value));
      changes.push(`Stop loss set to ${value}%`);
    }

    // Parse take profit
    const tpMatch = text.match(/take\s*profit\s*(?:to\s*)?(\d+)%?/i);
    if (tpMatch) {
      const value = parseInt(tpMatch[1], 10);
      runtime.setSetting("TAKE_PROFIT_PERCENT", String(value));
      changes.push(`Take profit set to ${value}%`);
    }

    // Parse position size
    const posMatch = text.match(/position\s*(?:size)?\s*(?:to\s*)?(\d+)%?/i);
    if (posMatch) {
      const value = parseInt(posMatch[1], 10);
      runtime.setSetting("MAX_POSITION_SIZE_USD", String(value * 10)); // Convert % to rough USD
      changes.push(`Max position size set to ${value}%`);
    }

    // Parse liquidity requirement
    const liqMatch = text.match(/liquidity\s*(?:to\s*)?\$?(\d+)k?/i);
    if (liqMatch) {
      let value = parseInt(liqMatch[1], 10);
      if (text.includes("k")) value *= 1000;
      runtime.setSetting("MIN_LIQUIDITY_USD", String(value));
      if (validationService) {
        validationService.setRequirements({ minLiquidityUsd: value });
      }
      changes.push(`Minimum liquidity set to $${value.toLocaleString()}`);
    }

    // Parse volume requirement
    const volMatch = text.match(/volume\s*(?:to\s*)?\$?(\d+)k?/i);
    if (volMatch) {
      let value = parseInt(volMatch[1], 10);
      if (text.includes("k")) value *= 1000;
      runtime.setSetting("MIN_VOLUME_24H_USD", String(value));
      if (validationService) {
        validationService.setRequirements({ minVolume24hUsd: value });
      }
      changes.push(`Minimum 24h volume set to $${value.toLocaleString()}`);
    }

    // Parse trading mode
    if (text.includes("live") && text.includes("mode")) {
      runtime.setSetting("TRADING_MODE", "live");
      changes.push("⚠️ Trading mode set to LIVE - real funds will be used!");
    } else if (text.includes("paper") && text.includes("mode")) {
      runtime.setSetting("TRADING_MODE", "paper");
      changes.push("Trading mode set to paper (simulated)");
    }

    if (changes.length === 0) {
      const currentSettings = `📋 **Current Settings**

**Risk Management:**
• Stop Loss: ${runtime.getSetting("STOP_LOSS_PERCENT") || "5"}%
• Take Profit: ${runtime.getSetting("TAKE_PROFIT_PERCENT") || "15"}%
• Max Position Size: ${runtime.getSetting("MAX_POSITION_SIZE_USD") || "100"} USD

**Token Filters:**
• Min Liquidity: $${runtime.getSetting("MIN_LIQUIDITY_USD") || "50000"}
• Min Volume 24h: $${runtime.getSetting("MIN_VOLUME_24H_USD") || "100000"}

**Mode:**
• Trading Mode: ${runtime.getSetting("TRADING_MODE") || "paper"}

**Example Commands:**
• "Set stop loss to 3%"
• "Set take profit to 20%"
• "Set liquidity to $100k"
• "Set volume to $500k"
• "Set paper mode" or "Set live mode"`;

      callback?.({ text: currentSettings });
      return undefined;
    }

    const response = `✅ **Settings Updated**

${changes.map((c) => `• ${c}`).join("\n")}

${changes.some((c) => c.includes("LIVE")) ? "\n⚠️ **WARNING:** Live mode enabled. Real funds at risk!" : ""}

Use "configure" to see current settings.`;

    callback?.({ text: response });
    return undefined;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Set stop loss to 3% and take profit to 25%" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Settings updated: Stop loss 3%, Take profit 25%" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Configure minimum liquidity to $100k" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Minimum liquidity set to $100,000" },
      },
    ],
  ],
};
