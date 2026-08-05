/**
 * @elizaos/plugin-dflow-trade
 *
 * Natural-language Solana spot trading for elizaOS agents via:
 *   - DFLOW_API_KEY → https://quote-api.dflow.net (GET /order)
 *   - HELIUS_RPC_URL → broadcast / balance
 *   - DEEPSEEK_API_KEY → LLM (or any provider); this plugin supplies tools + context
 *
 * Preview-first. Live swaps require SOLANA_TRADE_LIVE=true + SOLANA_PRIVATE_KEY.
 */

import type { Plugin } from "@elizaos/core";
import { dflowBalanceAction } from "./actions/balance.js";
import { dflowQuoteAction } from "./actions/quote.js";
import { dflowSwapAction } from "./actions/swap.js";
import { dflowTradeContextProvider } from "./providers/trade-context.js";

export { readDflowTradeConfig, formatReadiness, resolveMint, toAtomicAmount, KNOWN_MINTS } from "./config.js";
export type { DflowTradeConfig } from "./config.js";
export { DflowClient, formatQuote } from "./client/dflow-client.js";
export type { DflowOrderRequest, DflowOrderResponse } from "./client/dflow-client.js";
export { parseTradeIntent, looksLikeTradeUtterance } from "./parse-trade.js";
export { dflowQuoteAction } from "./actions/quote.js";
export { dflowSwapAction } from "./actions/swap.js";
export { dflowBalanceAction } from "./actions/balance.js";
export { dflowTradeContextProvider } from "./providers/trade-context.js";

export const dflowTradePlugin: Plugin = {
  name: "@elizaos/plugin-dflow-trade",
  description:
    "Official Solana spot trading via DFlow (DFLOW_API_KEY) + Helius RPC. Quote/swap/status actions; preview-first, live with SOLANA_TRADE_LIVE. Designed for DeepSeek and other LLM agents.",
  actions: [dflowQuoteAction, dflowSwapAction, dflowBalanceAction],
  providers: [dflowTradeContextProvider],
  services: [],
};

export default dflowTradePlugin;
