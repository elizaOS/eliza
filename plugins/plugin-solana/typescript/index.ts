import type { IAgentRuntime, Plugin, ServiceTypeName } from "@elizaos/core";
import { executeSwap } from "./actions/swap";
import transferToken from "./actions/transfer";
import { SOLANA_SERVICE_NAME } from "./constants";
import { walletProvider } from "./providers/wallet";
import { solanaRoutes } from "./routes/index";
import { SolanaService, SolanaWalletService } from "./service";

function getStringSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  return typeof value === "string" ? value : null;
}

function parseBoolSetting(value: string | number | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const str = String(value).toLowerCase().trim();
  return str === "true" || str === "1" || str === "yes";
}

export const solanaPlugin: Plugin = {
  name: SOLANA_SERVICE_NAME,
  description: "Solana blockchain plugin",
  services: [SolanaService, SolanaWalletService],
  routes: solanaRoutes,
  init: async (_, runtime: IAgentRuntime) => {
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

    runtime
      .getServiceLoadPromise("INTEL_CHAIN" as ServiceTypeName)
      .then(() => {
        const traderChainService = runtime.getService("INTEL_CHAIN");
        if (
          traderChainService &&
          typeof traderChainService === "object" &&
          "registerChain" in traderChainService &&
          typeof traderChainService.registerChain === "function"
        ) {
          traderChainService.registerChain({
            name: "Solana services",
            chain: "solana",
            service: SOLANA_SERVICE_NAME,
          });
        }
      })
      .catch((error) => {
        runtime.logger.error({ error }, "Failed to register with INTEL_CHAIN");
      });
  },
};
export default solanaPlugin;

export { SOLANA_SERVICE_NAME } from "./constants";
export type { SolanaService as ISolanaService } from "./service";
export { SolanaService, SolanaWalletService } from "./service";
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
