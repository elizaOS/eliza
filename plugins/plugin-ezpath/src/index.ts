import type { Plugin } from "@elizaos/core";
import { getQuoteAction } from "./actions/getQuote.js";

export { getQuote, TIER_ATOMIC, USDC_BASE, EZPATH_API } from "./client.js";
export type { QuoteResult, RoutingMetadata, Tier } from "./client.js";

const plugin: Plugin = {
  name: "plugin-ezpath",
  description:
    "Pay-per-request DEX price router on Base mainnet. Fetches normalized swap quotes via EZ-Path " +
    "with automatic X402 USDC payment negotiation. Supports basic ($0.03), resilient ($0.10), " +
    "and institutional ($0.50) execution tiers.",
  actions: [getQuoteAction],
};

export default plugin;
