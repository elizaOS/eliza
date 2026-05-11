import { resolveCloudRoute, toRuntimeSettings } from "@elizaos/cloud-routing";
import {
  type IAgentRuntime,
  type Plugin,
  parseBooleanFromText,
  type ServiceClass,
} from "@elizaos/core";
import { agentPortfolioProvider } from "./analytics/birdeye/providers/agent-portfolio-provider.js";
import { marketProvider } from "./analytics/birdeye/providers/market.js";
import { trendingProvider } from "./analytics/birdeye/providers/trending.js";
import { registerBirdeyeSearchCategories } from "./analytics/birdeye/search-category.js";
import {
  BIRDEYE_ROUTE_SPEC,
  BirdeyeService,
} from "./analytics/birdeye/service.js";
import { registerDexScreenerSearchCategory } from "./analytics/dexscreener/search-category.js";
import { DexScreenerService } from "./analytics/dexscreener/service.js";
import { TokenInfoService } from "./analytics/token-info/service.js";
import evmPlugin from "./chains/evm/index.js";
import solanaPlugin from "./chains/solana/index.js";
import { unifiedWalletProvider } from "./providers/unified-wallet-provider.js";
import { WalletBackendService } from "./services/wallet-backend-service.js";

const coreWalletPlugin: Plugin = {
  name: "wallet-backend",
  description:
    "Wallet backend service + unified wallet provider (Steward / local).",
  services: [WalletBackendService],
  providers: [unifiedWalletProvider],
  actions: [],
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

async function initBirdeyeAnalytics(runtime: IAgentRuntime): Promise<void> {
  const birdeyeRoute = resolveCloudRoute(
    toRuntimeSettings(runtime),
    BIRDEYE_ROUTE_SPEC,
  );
  registerBirdeyeSearchCategories(runtime, {
    enabled: birdeyeRoute.source !== "disabled",
    disabledReason:
      birdeyeRoute.source === "disabled"
        ? "BIRDEYE_API_KEY or Eliza Cloud route is not configured."
        : undefined,
  });
  if (birdeyeRoute.source === "disabled") {
    runtime.logger.log(
      "birdeye: no BIRDEYE_API_KEY and Eliza Cloud not connected, skipping plugin-birdeye init",
    );
    return;
  }

  const walletAddr = runtime.getSetting("BIRDEYE_WALLET_ADDR");
  if (walletAddr) {
    runtime.registerProvider(agentPortfolioProvider);
  }
  runtime.registerProvider(marketProvider);

  const beNoTrending = parseBooleanFromText(
    String(runtime.getSetting("BIRDEYE_NO_TRENDING") ?? ""),
  );
  if (!beNoTrending) {
    runtime.registerProvider(trendingProvider);
  } else {
    runtime.logger.log(
      "BIRDEYE_NO_TRENDING is set, skipping trending provider",
    );
  }
}

const analyticsServices: ServiceClass[] = [
  BirdeyeService,
  DexScreenerService,
  TokenInfoService,
] as ServiceClass[];

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
    analyticsServices,
  ),
  providers: concatPlugins(coreWalletPlugin.providers, evmPlugin.providers),
  actions: concatPlugins(coreWalletPlugin.actions, evmPlugin.actions),
  routes: concatPlugins(solanaPlugin.routes),
  init: async (config, runtime) => {
    await coreWalletPlugin.init?.(config, runtime);
    await evmPlugin.init?.(config, runtime);
    await solanaPlugin.init?.(config, runtime);
    registerDexScreenerSearchCategory(runtime);
    await initBirdeyeAnalytics(runtime);
  },
};

export default walletPlugin;
