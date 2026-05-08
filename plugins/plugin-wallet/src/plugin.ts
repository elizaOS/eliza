import type { Plugin, ServiceClass } from "@elizaos/core";
import { registerBirdeyeSearchCategories } from "./analytics/birdeye/search-category.js";
import { registerDexScreenerSearchCategory } from "./analytics/dexscreener/search-category.js";
import { DexScreenerService } from "./analytics/dexscreener/service.js";
import { tokenInfoAction } from "./analytics/token-info/action.js";
import { TokenInfoService } from "./analytics/token-info/service.js";
import evmPlugin from "./chains/evm/index.js";
import solanaPlugin from "./chains/solana/index.js";
import { unifiedWalletProvider } from "./providers/unified-wallet-provider.js";
import { WalletBackendService } from "./services/wallet-backend-service.js";

const coreWalletPlugin: Plugin = {
  name: "wallet-backend",
  description:
    "Wallet backend service + unified wallet provider (Steward / local).",
  services: [WalletBackendService, DexScreenerService, TokenInfoService],
  providers: [unifiedWalletProvider],
  actions: [tokenInfoAction],
  evaluators: [],
};

function concatServices(
  ...chunks: (readonly ServiceClass[] | undefined)[]
): ServiceClass[] {
  const out: ServiceClass[] = [];
  for (const c of chunks) {
    if (c) out.push(...c);
  }
  return out;
}

function concatPlugins<T>(...chunks: (readonly T[] | undefined)[]): T[] {
  const out: T[] = [];
  for (const c of chunks) {
    if (c) out.push(...c);
  }
  return out;
}

/**
 * Single plugin surface: EVM + Solana wallet backend.
 * Consumers should depend only on `@elizaos/plugin-wallet`.
 */
export const walletPlugin: Plugin = {
  name: "wallet",
  description:
    "Unified non-custodial wallet for elizaOS — EVM + Solana, Steward/local backends, x402, CCTP, and venue routing.",
  services: concatServices(
    coreWalletPlugin.services,
    evmPlugin.services as ServiceClass[] | undefined,
    solanaPlugin.services as ServiceClass[] | undefined,
  ),
  providers: concatPlugins(coreWalletPlugin.providers, evmPlugin.providers),
  evaluators: concatPlugins(coreWalletPlugin.evaluators, evmPlugin.evaluators),
  actions: concatPlugins(coreWalletPlugin.actions, evmPlugin.actions),
  routes: concatPlugins(solanaPlugin.routes),
  init: async (config, runtime) => {
    await coreWalletPlugin.init?.(config, runtime);
    registerDexScreenerSearchCategory(runtime);
    registerBirdeyeSearchCategories(runtime);
    await evmPlugin.init?.(config, runtime);
    await solanaPlugin.init?.(config, runtime);
  },
};

export default walletPlugin;
