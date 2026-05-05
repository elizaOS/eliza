// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { Plugin } from "@elizaos/core";

// Steer Finance Plugin
import { steerPlugin } from "./steer";

// Kamino Protocol Plugin
import { kaminoPlugin } from "./kamino";

/**
 * Liquidity Pool Information Plugin
 *
 * A comprehensive plugin that provides liquidity pool management and analytics
 * for multiple DeFi protocols on Solana.
 *
 * Supported Protocols:
 * - Steer Finance: Vault and staking pool management
 * - Kamino Protocol: Lending and liquidity pool management
 *
 * Features:
 * - Multi-protocol liquidity pool tracking
 * - Yield optimization analytics
 * - Position tracking and management
 * - Market data and statistics
 *
 * @author ElizaOS
 * @version 1.0.0
 */
export const lpinfoPlugin: Plugin = {
  name: "lpinfo",
  description:
    "Comprehensive liquidity pool information plugin supporting Steer Finance and Kamino Protocol for pool tracking, yield optimization, and position management",
  evaluators: [],
  providers: [
    ...(steerPlugin.providers || []),
    ...(kaminoPlugin.providers || []),
  ],
  actions: [...(steerPlugin.actions || []), ...(kaminoPlugin.actions || [])],
  services: [...(steerPlugin.services || []), ...(kaminoPlugin.services || [])],
};

export default lpinfoPlugin;

// Re-export sub-plugins for granular control if needed
export { steerPlugin } from "./steer";
export { kaminoPlugin } from "./kamino";

// Export Steer components
export * from "./steer/providers/steerLiquidityProvider";
export * from "./steer/services/steerLiquidityService";

// Export Kamino components
export * from "./kamino/providers/kaminoProvider";
export * from "./kamino/providers/kaminoLiquidityProvider";
export * from "./kamino/providers/kaminoPoolProvider";
export * from "./kamino/services/kaminoService";
export * from "./kamino/services/kaminoLiquidityService";
