// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { Plugin } from "@elizaos/core";
import { kaminoLiquidityProvider } from "./providers/kaminoLiquidityProvider";
import { kaminoPoolProvider } from "./providers/kaminoPoolProvider";
// Providers
import { kaminoProvider } from "./providers/kaminoProvider";
import { KaminoLiquidityService } from "./services/kaminoLiquidityService";
// Services
import { KaminoService } from "./services/kaminoService";

/**
 * Kamino Protocol Plugin
 * Provides comprehensive access to Kamino lending and liquidity protocols
 */
export const kaminoPlugin: Plugin = {
  name: "kamino-protocol",
  description:
    "Comprehensive Kamino protocol integration for viewing lending positions, liquidity pools, and market analytics. Supports position tracking and yield optimization.",
  providers: [kaminoProvider, kaminoLiquidityProvider, kaminoPoolProvider],
  actions: [],
  services: [KaminoService, KaminoLiquidityService],
};

export default kaminoPlugin;
