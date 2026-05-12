// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type IAgentRuntime,
  logger,
  type Plugin,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { liquidityAction } from "./actions/liquidity.ts";
import { realTokenTestsSuite } from "./e2e/real-token-tests.ts";
import { lpManagerScenariosSuite } from "./e2e/scenarios.ts";
import { ConcentratedLiquidityService } from "./services/ConcentratedLiquidityService.ts";
import { DexInteractionService } from "./services/DexInteractionService.ts";
import { LpManagementService } from "./services/LpManagementService.ts";
import { UserLpProfileService } from "./services/UserLpProfileService.ts";
import { VaultService } from "./services/VaultService.ts";
import { YieldOptimizationService } from "./services/YieldOptimizationService.ts";
// LpAutoRebalanceTask import removed - file doesn't exist
import type { EvmDex, SolanaDex } from "./types.ts";

// It's good practice to define a unique name for the plugin
export const LP_MANAGER_PLUGIN_NAME = "@elizaos/plugin-lp-manager";

/**
 * Determines which DEXes to load based on available credentials and configuration
 */
function getDexConfiguration(runtime: IAgentRuntime): {
  solanaDexes: SolanaDex[];
  evmDexes: EvmDex[];
  hasSolana: boolean;
  hasEvm: boolean;
} {
  const solanaPrivateKey = runtime.getSetting("SOLANA_PRIVATE_KEY");
  const evmPrivateKey = runtime.getSetting("EVM_PRIVATE_KEY");

  // Check for chain-specific RPC URLs to determine which chains are configured
  const hasEthereumRpc = !!(
    runtime.getSetting("ETHEREUM_RPC_URL") ||
    runtime.getSetting("EVM_PROVIDER_MAINNET")
  );
  const hasBaseRpc = !!(
    runtime.getSetting("BASE_RPC_URL") ||
    runtime.getSetting("EVM_PROVIDER_BASE")
  );
  const hasBscRpc = !!(
    runtime.getSetting("BSC_RPC_URL") || runtime.getSetting("EVM_PROVIDER_BSC")
  );
  const hasArbitrumRpc = !!(
    runtime.getSetting("ARBITRUM_RPC_URL") ||
    runtime.getSetting("EVM_PROVIDER_ARBITRUM")
  );
  const hasSolanaRpc = !!runtime.getSetting("SOLANA_RPC_URL");

  const hasSolanaWallet = !!(
    solanaPrivateKey && typeof solanaPrivateKey === "string"
  );
  const hasEvmWallet = !!(evmPrivateKey && typeof evmPrivateKey === "string");
  const hasSolana = hasSolanaWallet || hasSolanaRpc;
  const hasEvm =
    hasEvmWallet || hasEthereumRpc || hasBaseRpc || hasBscRpc || hasArbitrumRpc;

  // Determine Solana DEXes to load
  const solanaDexes: SolanaDex[] = [];
  if (hasSolana) {
    // Check for specific DEX preferences from config, otherwise load all
    const preferredSolanaDexes = runtime.getSetting("LP_SOLANA_DEXES");
    if (preferredSolanaDexes && typeof preferredSolanaDexes === "string") {
      const dexList = preferredSolanaDexes
        .split(",")
        .map((d) => d.trim().toLowerCase() as SolanaDex);
      solanaDexes.push(
        ...dexList.filter((d) => ["raydium", "orca", "meteora"].includes(d)),
      );
    } else {
      // Default: load all Solana DEXes
      solanaDexes.push("raydium", "orca", "meteora");
    }
  }

  // Determine EVM DEXes to load based on available RPCs
  const evmDexes: EvmDex[] = [];
  if (hasEvm) {
    const preferredEvmDexes = runtime.getSetting("LP_EVM_DEXES");
    if (preferredEvmDexes && typeof preferredEvmDexes === "string") {
      const dexList = preferredEvmDexes
        .split(",")
        .map((d) => d.trim().toLowerCase() as EvmDex);
      evmDexes.push(
        ...dexList.filter((d) =>
          ["uniswap", "pancakeswap", "aerodrome"].includes(d),
        ),
      );
    } else {
      // Auto-detect based on configured RPCs
      if (hasEthereumRpc || hasArbitrumRpc) {
        evmDexes.push("uniswap");
      }
      if (hasBscRpc || hasArbitrumRpc) {
        evmDexes.push("pancakeswap");
      }
      if (hasBaseRpc) {
        evmDexes.push("aerodrome");
        if (!evmDexes.includes("uniswap")) {
          evmDexes.push("uniswap"); // Uniswap is also on Base
        }
      }
    }
  }

  return { solanaDexes, evmDexes, hasSolana, hasEvm };
}

/**
 * Dynamically loads Solana DEX plugins
 */
async function loadSolanaDexes(
  dexes: SolanaDex[],
  config: Record<string, string>,
  runtime: IAgentRuntime,
): Promise<void> {
  for (const dex of dexes) {
    try {
      switch (dex) {
        case "raydium": {
          const { raydiumPlugin } = await import(
            "../chains/solana/dex/raydium/index.ts"
          );
          if (raydiumPlugin.init) {
            await raydiumPlugin.init(config, runtime);
          }
          logger.info(`[LP Manager] Loaded Raydium DEX`);
          break;
        }
        case "orca": {
          const { orcaPlugin } = await import(
            "../chains/solana/dex/orca/index.ts"
          );
          if (orcaPlugin.init) {
            await orcaPlugin.init(config, runtime);
          }
          logger.info(`[LP Manager] Loaded Orca DEX`);
          break;
        }
        case "meteora": {
          const meteoraPlugin = await import(
            "../chains/solana/dex/meteora/index.ts"
          );
          if (meteoraPlugin.default?.init) {
            await meteoraPlugin.default.init(config, runtime);
          }
          logger.info(`[LP Manager] Loaded Meteora DEX`);
          break;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `[LP Manager] Failed to load ${dex} DEX:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * Dynamically loads EVM DEX plugins
 */
async function loadEvmDexes(
  dexes: EvmDex[],
  config: Record<string, string>,
  runtime: IAgentRuntime,
): Promise<void> {
  for (const dex of dexes) {
    try {
      switch (dex) {
        case "uniswap": {
          const { uniswapPlugin } = await import(
            "../chains/evm/dex/uniswap/index.ts"
          );
          if (uniswapPlugin.init) {
            await uniswapPlugin.init(config, runtime);
          }
          logger.info(`[LP Manager] Loaded Uniswap V3 DEX`);
          break;
        }
        case "pancakeswap": {
          const { pancakeswapPlugin } = await import(
            "../chains/evm/dex/pancakeswp/index.ts"
          );
          if (pancakeswapPlugin.init) {
            await pancakeswapPlugin.init(config, runtime);
          }
          logger.info(`[LP Manager] Loaded PancakeSwap V3 DEX`);
          break;
        }
        case "aerodrome": {
          const { aerodromePlugin } = await import(
            "../chains/evm/dex/aerodrome/index.ts"
          );
          if (aerodromePlugin.init) {
            await aerodromePlugin.init(config, runtime);
          }
          logger.info(`[LP Manager] Loaded Aerodrome DEX`);
          break;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `[LP Manager] Failed to load ${dex} DEX:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

const lpManagerPlugin: Plugin = {
  name: LP_MANAGER_PLUGIN_NAME,
  description:
    "Unified Liquidity Pool manager for Solana DEXs (Raydium, Orca, Meteora) and EVM DEXs (Uniswap, PancakeSwap, Aerodrome).",
  actions: [...promoteSubactionsToActions(liquidityAction)],
  services: [
    LpManagementService,
    VaultService,
    UserLpProfileService,
    DexInteractionService,
    YieldOptimizationService,
    ConcentratedLiquidityService,
  ],
  tests: [lpManagerScenariosSuite, realTokenTestsSuite],

  init: async (
    config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> => {
    logger.info(`[LP Manager] Initializing ${LP_MANAGER_PLUGIN_NAME}...`);

    // Determine which DEXes to load based on configuration
    const { solanaDexes, evmDexes, hasSolana, hasEvm } =
      getDexConfiguration(runtime);

    logger.info(`[LP Manager] Configuration detected:`);
    logger.info(
      `  - Solana: ${hasSolana ? "enabled" : "disabled"} (DEXes: ${solanaDexes.join(", ") || "none"})`,
    );
    logger.info(
      `  - EVM: ${hasEvm ? "enabled" : "disabled"} (DEXes: ${evmDexes.join(", ") || "none"})`,
    );

    if (!hasSolana && !hasEvm) {
      logger.warn(
        `[LP Manager] No LP chain configuration found. Set SOLANA_RPC_URL, an EVM RPC URL, SOLANA_PRIVATE_KEY, or EVM_PRIVATE_KEY.`,
      );
      logger.warn(
        `[LP Manager] No production mock LP services will be registered.`,
      );
      return;
    }

    // Load Solana DEXes
    if (solanaDexes.length > 0) {
      await loadSolanaDexes(solanaDexes, config, runtime);
    }

    // Load EVM DEXes
    if (evmDexes.length > 0) {
      await loadEvmDexes(evmDexes, config, runtime);
    }

    logger.info(
      `[LP Manager] Plugin ${LP_MANAGER_PLUGIN_NAME} initialized successfully.`,
    );
  },
};

export default lpManagerPlugin;

export {
  AerodromeLpService,
  aerodromePlugin,
} from "../chains/evm/dex/aerodrome/index.ts";
export {
  PancakeSwapV3LpService,
  pancakeswapPlugin,
} from "../chains/evm/dex/pancakeswp/index.ts";
// Export sub-plugins for direct use
export {
  UniswapV3LpService,
  uniswapPlugin,
} from "../chains/evm/dex/uniswap/index.ts";
export { orcaPlugin } from "../chains/solana/dex/orca/index.ts";
export { raydiumPlugin } from "../chains/solana/dex/raydium/index.ts";
// Export types
export * from "./types.ts";
// Export all services and utilities
// Back-compat alias for older imports.
export {
  ConcentratedLiquidityService,
  DexInteractionService,
  LpManagementService,
  liquidityAction,
  liquidityAction as LpManagementAgentAction,
  UserLpProfileService,
  VaultService,
  YieldOptimizationService,
};
