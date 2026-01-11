import type { IAgentRuntime, Plugin, ServiceTypeName } from "@elizaos/core";

// actions
import { executeSwap } from "./actions/swap";
import transferToken from "./actions/transfer";
import { SOLANA_SERVICE_NAME } from "./constants";
// providers
import { walletProvider } from "./providers/wallet";
// routes
import { solanaRoutes } from "./routes/index";
// service
import { SolanaService, SolanaWalletService } from "./service";

/**
 * Get a string setting from runtime, returning null if not a string.
 */
function getStringSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  if (typeof value === "string") {
    return value;
  }
  return null;
}

/**
 * Parse a boolean from a setting value.
 */
function parseBoolSetting(value: string | number | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const str = value.toLowerCase().trim();
  return str === "true" || str === "1" || str === "yes";
}

export const solanaPlugin: Plugin = {
  name: SOLANA_SERVICE_NAME,
  description: "Solana blockchain plugin",
  services: [SolanaService, SolanaWalletService],
  routes: solanaRoutes,
  init: async (_, runtime: IAgentRuntime) => {
    // Validation
    if (!getStringSetting(runtime, "SOLANA_RPC_URL")) {
      runtime.logger.log("no SOLANA_RPC_URL, skipping plugin-solana init");
      return;
    }

    const noActions = parseBoolSetting(runtime.getSetting("SOLANA_NO_ACTIONS"));
    if (!noActions) {
      runtime.registerAction(transferToken);
      runtime.registerAction(executeSwap);
    } else {
      runtime.logger.log("SOLANA_NO_ACTIONS is set, skipping solana actions");
    }

    runtime.registerProvider(walletProvider);

    // extensions
    runtime
      .getServiceLoadPromise("INTEL_CHAIN" as ServiceTypeName as string as ServiceTypeName)
      .then(() => {
        const traderChainService = runtime.getService("INTEL_CHAIN") as unknown;
        if (
          traderChainService &&
          typeof traderChainService === "object" &&
          "registerChain" in traderChainService &&
          typeof (traderChainService as { registerChain: unknown }).registerChain === "function"
        ) {
          const me = {
            name: "Solana services",
            chain: "solana",
            service: SOLANA_SERVICE_NAME,
          };
          (
            traderChainService as {
              registerChain: (info: Record<string, string>) => void;
            }
          ).registerChain(me);
        }
      })
      .catch((error) => {
        runtime.logger.error({ error }, "Failed to register with INTEL_CHAIN");
      });
  },
};
export default solanaPlugin;

// Export additional items for use by other plugins
export { SOLANA_SERVICE_NAME } from "./constants";
export type { SolanaService as ISolanaService } from "./service";
export { SolanaService, SolanaWalletService } from "./service";

// Export API types for HTTP routes
export type {
  ApiError,
  ApiResponse,
  PortfolioTokenResponse,
  TokenAccountResponse,
  TokenBalanceResponse,
  WalletAddressResponse,
  WalletBalanceResponse,
  WalletPortfolioResponse,
  WalletTokensResponse,
} from "./types";
