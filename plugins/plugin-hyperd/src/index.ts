/**
 * @hyperd-ai/plugin-hyperd — ElizaOS plugin for hyperD
 *
 * Exposes 5 hyperD endpoints as agent actions:
 *   • HYPERD_WALLET_RISK       — Chainalysis Sanctions + GoPlus heuristics ($0.10)
 *   • HYPERD_TOKEN_SECURITY    — GoPlus token risk score ($0.05)
 *   • HYPERD_LIQUIDATION_RISK  — Cross-protocol health factor ($0.10)
 *   • HYPERD_WALLET_PNL        — Realized + unrealized P&L ($0.05)
 *   • HYPERD_DEX_QUOTE         — Best swap route aggregator ($0.02)
 *
 * Full agent decision-cycle cost (call all 5): $0.32.
 *
 * Requires env / agentConfig:
 *   HYPERD_BUYER_PRIVATE_KEY  (required) — 0x-prefixed EVM private key
 *   HYPERD_API_BASE           (optional, default https://api.hyperd.ai)
 *   HYPERD_MAX_USDC_PER_CALL  (optional, default 0.25)
 *
 * The wallet at HYPERD_BUYER_PRIVATE_KEY must hold USDC on Base. The plugin
 * signs EIP-3009 transfer authorizations per call; settlement happens via
 * Coinbase's x402 facilitator in roughly two seconds.
 */

import type { Plugin } from "@elizaos/core";
import { walletRiskAction } from "./actions/walletRisk.js";
import { tokenSecurityAction } from "./actions/tokenSecurity.js";
import { liquidationRiskAction } from "./actions/liquidationRisk.js";
import { walletPnlAction } from "./actions/walletPnl.js";
import { dexQuoteAction } from "./actions/dexQuote.js";

export const hyperdPlugin: Plugin = {
  name: "hyperd",
  description:
    "On-demand DeFi intelligence for elizaOS agents — wallet risk, token security, liquidation alerts, P&L, DEX quotes. Paid per-call in USDC on Base via x402. No API key, no signup.",
  actions: [
    walletRiskAction,
    tokenSecurityAction,
    liquidationRiskAction,
    walletPnlAction,
    dexQuoteAction,
  ],
};

export default hyperdPlugin;

// Named re-exports — useful for typed consumers and tests.
export {
  walletRiskAction,
  tokenSecurityAction,
  liquidationRiskAction,
  walletPnlAction,
  dexQuoteAction,
};
export { HyperdClient, HyperdRequestError } from "./client.js";
export { resolveConfig } from "./config.js";
export type { HyperdConfig } from "./config.js";
export type {
  WalletRiskResponse,
  TokenSecurityResponse,
  LiquidationRiskResponse,
  WalletPnlResponse,
  DexQuoteResponse,
  HyperdAnyResponse,
} from "./types.js";
