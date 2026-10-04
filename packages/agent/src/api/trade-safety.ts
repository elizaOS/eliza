/** Compatibility path; implementation belongs to plugin-wallet. */
export {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  assertQuoteFresh,
  canUseLocalTradeExecution,
  getAgentAutoTradeDate,
  type LocalTradeExecutionOptions,
  QUOTE_MAX_AGE_MS,
  recordAgentAutoTrade,
  type TradePermissionMode,
} from "@elizaos/plugin-wallet/transactions";
