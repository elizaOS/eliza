/** Multi-provider RPC: Alchemy, Infura, Ankr, Eliza Cloud with per-chain fallback. */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

function hasStringSetting(runtime: IAgentRuntime, key: string): boolean {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim().length > 0;
}

function getStringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : undefined;
}

function getObjectProperty(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return Reflect.get(source, key);
}

function getObjectStringProperty(source: unknown, key: string): string | undefined {
  const value = getObjectProperty(source, key);
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : undefined;
}

function getCharacterSecret(runtime: IAgentRuntime, key: string): string | undefined {
  const character = runtime.character;
  const settings = getObjectProperty(character, "settings");
  return (
    getObjectStringProperty(getObjectProperty(character, "secrets"), key) ??
    getObjectStringProperty(getObjectProperty(settings, "secrets"), key)
  );
}

function getCloudApiKey(runtime: IAgentRuntime): string | undefined {
  return (
    getStringSetting(runtime, "ELIZAOS_CLOUD_API_KEY") ??
    getCharacterSecret(runtime, "ELIZAOS_CLOUD_API_KEY") ??
    (process.env.ELIZAOS_CLOUD_API_KEY?.trim() || undefined)
  );
}

function hasCloudRpcAccess(runtime: IAgentRuntime): boolean {
  return Boolean(getCloudApiKey(runtime));
}

export type RPCProviderName = "alchemy" | "infura" | "ankr" | "elizacloud";

export interface RPCProviderConfig {
  name: RPCProviderName;
  apiKey: string;
  supportedChains: ReadonlySet<string>;
  buildUrl: (chainName: string, apiKey: string) => string | null;
}

// Alchemy: https://docs.alchemy.com/reference/supported-chains
const ALCHEMY_CHAIN_MAP: Readonly<Record<string, string>> = {
  mainnet: "eth-mainnet",
  sepolia: "eth-sepolia",
  holesky: "eth-holesky",
  polygon: "polygon-mainnet",
  polygonMumbai: "polygon-mumbai",
  polygonAmoy: "polygon-amoy",
  arbitrum: "arb-mainnet",
  arbitrumSepolia: "arb-sepolia",
  optimism: "opt-mainnet",
  optimismSepolia: "opt-sepolia",
  base: "base-mainnet",
  baseSepolia: "base-sepolia",
  zksync: "zksync-mainnet",
  zksyncSepolia: "zksync-sepolia",
  linea: "linea-mainnet",
  lineaSepolia: "linea-sepolia",
  scroll: "scroll-mainnet",
  scrollSepolia: "scroll-sepolia",
  blast: "blast-mainnet",
  blastSepolia: "blast-sepolia",
  avalanche: "avax-mainnet",
  avalancheFuji: "avax-fuji",
  bsc: "bnb-mainnet",
  bscTestnet: "bnb-testnet",
  celo: "celo-mainnet",
  celoAlfajores: "celo-alfajores",
  gnosis: "gnosis-mainnet",
  worldchain: "worldchain-mainnet",
  shape: "shape-mainnet",
};

// Infura: https://docs.infura.io/api/networks
const INFURA_CHAIN_MAP: Readonly<Record<string, string>> = {
  mainnet: "mainnet",
  sepolia: "sepolia",
  holesky: "holesky",
  polygon: "polygon-mainnet",
  polygonMumbai: "polygon-mumbai",
  polygonAmoy: "polygon-amoy",
  arbitrum: "arbitrum-mainnet",
  arbitrumSepolia: "arbitrum-sepolia",
  optimism: "optimism-mainnet",
  optimismSepolia: "optimism-sepolia",
  base: "base-mainnet",
  baseSepolia: "base-sepolia",
  linea: "linea-mainnet",
  lineaSepolia: "linea-sepolia",
  blast: "blast-mainnet",
  avalanche: "avalanche-mainnet",
  avalancheFuji: "avalanche-fuji",
  bsc: "bsc-mainnet",
  celo: "celo-mainnet",
  celoAlfajores: "celo-alfajores",
  scroll: "scroll-mainnet",
  scrollSepolia: "scroll-sepolia",
  mantle: "mantle-mainnet",
  mantleSepolia: "mantle-sepolia",
  zkSyncEra: "zksync-mainnet",
  zkSyncSepolia: "zksync-sepolia",
  gnosis: "gnosis-mainnet",
};

// Ankr: https://www.ankr.com/docs/rpc-service/chains/chains-list/
const ANKR_CHAIN_MAP: Readonly<Record<string, string>> = {
  mainnet: "eth",
  sepolia: "eth_sepolia",
  holesky: "eth_holesky",
  polygon: "polygon",
  polygonMumbai: "polygon_mumbai",
  polygonAmoy: "polygon_amoy",
  arbitrum: "arbitrum",
  arbitrumSepolia: "arbitrum_sepolia",
  optimism: "optimism",
  optimismSepolia: "optimism_sepolia",
  base: "base",
  baseSepolia: "base_sepolia",
  avalanche: "avalanche",
  avalancheFuji: "avalanche_fuji",
  bsc: "bsc",
  bscTestnet: "bsc_testnet_chapel",
  gnosis: "gnosis",
  fantom: "fantom",
  celo: "celo",
  linea: "linea",
  scroll: "scroll",
  blast: "blast",
  zksync: "zksync_era",
  mantle: "mantle",
  mode: "mode",
};

// Eliza Cloud proxy — shared endpoint for all chains
const ELIZACLOUD_SUPPORTED_CHAINS = new Set([
  "mainnet",
  "sepolia",
  "holesky",
  "polygon",
  "polygonMumbai",
  "polygonAmoy",
  "arbitrum",
  "arbitrumSepolia",
  "optimism",
  "optimismSepolia",
  "base",
  "baseSepolia",
  "avalanche",
  "avalancheFuji",
  "bsc",
  "bscTestnet",
  "gnosis",
  "fantom",
  "celo",
  "celoAlfajores",
  "linea",
  "lineaSepolia",
  "scroll",
  "scrollSepolia",
  "blast",
  "blastSepolia",
  "zksync",
  "zksyncSepolia",
  "mantle",
  "mantleSepolia",
  "mode",
]);

function createAlchemyProvider(apiKey: string): RPCProviderConfig {
  return {
    name: "alchemy",
    apiKey,
    supportedChains: new Set(Object.keys(ALCHEMY_CHAIN_MAP)),
    buildUrl(chainName: string, key: string): string | null {
      const slug = ALCHEMY_CHAIN_MAP[chainName];
      if (!slug) return null;
      return `https://${slug}.g.alchemy.com/v2/${key}`;
    },
  };
}

function createInfuraProvider(apiKey: string): RPCProviderConfig {
  return {
    name: "infura",
    apiKey,
    supportedChains: new Set(Object.keys(INFURA_CHAIN_MAP)),
    buildUrl(chainName: string, key: string): string | null {
      const slug = INFURA_CHAIN_MAP[chainName];
      if (!slug) return null;
      return `https://${slug}.infura.io/v3/${key}`;
    },
  };
}

function createAnkrProvider(apiKey: string): RPCProviderConfig {
  return {
    name: "ankr",
    apiKey,
    supportedChains: new Set(Object.keys(ANKR_CHAIN_MAP)),
    buildUrl(chainName: string, key: string): string | null {
      const slug = ANKR_CHAIN_MAP[chainName];
      if (!slug) return null;
      return `https://rpc.ankr.com/${slug}/${key}`;
    },
  };
}

function createElizaCloudProvider(apiKey: string, baseUrl: string): RPCProviderConfig {
  return {
    name: "elizacloud",
    apiKey,
    supportedChains: ELIZACLOUD_SUPPORTED_CHAINS,
    buildUrl(chainName: string, _key: string): string | null {
      if (!ELIZACLOUD_SUPPORTED_CHAINS.has(chainName)) return null;
      return `${baseUrl}/proxy/evm-rpc/${chainName}`;
    },
  };
}

export interface ResolvedRPCProvider {
  providerName: RPCProviderName;
  rpcUrl: string;
  headers: Record<string, string>;
}

export interface RPCProviderManager {
  resolveForChain(chainName: string): ResolvedRPCProvider | null;
  getConfiguredProviders(): RPCProviderName[];
  getCoveredChains(): string[];
  isChainCovered(chainName: string): boolean;
}

export function initRPCProviderManager(runtime: IAgentRuntime): RPCProviderManager {
  const preferredRaw = runtime.getSetting("EVM_RPC_PROVIDER");
  const preferred =
    typeof preferredRaw === "string" ? (preferredRaw.toLowerCase() as RPCProviderName) : null;

  const providers: RPCProviderConfig[] = [];

  const alchemyKey = getStringSetting(runtime, "ALCHEMY_API_KEY");
  if (alchemyKey) providers.push(createAlchemyProvider(alchemyKey));

  const infuraKey = getStringSetting(runtime, "INFURA_API_KEY");
  if (infuraKey) providers.push(createInfuraProvider(infuraKey));

  const ankrKey = getStringSetting(runtime, "ANKR_API_KEY");
  if (ankrKey) providers.push(createAnkrProvider(ankrKey));

  if (hasCloudRpcAccess(runtime)) {
    const cloudKey = getCloudApiKey(runtime);
    if (cloudKey) {
      const cloudBase =
        getStringSetting(runtime, "ELIZAOS_CLOUD_BASE_URL") ??
        (process.env.ELIZAOS_CLOUD_BASE_URL?.trim() || undefined) ??
        "https://www.elizacloud.ai/api/v1";
      providers.push(createElizaCloudProvider(cloudKey, cloudBase));
    }
  }

  if (preferred) {
    providers.sort((a, b) => {
      if (a.name === preferred && b.name !== preferred) return -1;
      if (b.name === preferred && a.name !== preferred) return 1;
      return b.supportedChains.size - a.supportedChains.size;
    });
  }

  if (providers.length > 0) {
    logger.info(
      `[EVM-RPC] Configured providers: ${providers.map((p) => p.name).join(", ")}` +
        (preferred ? ` (preferred: ${preferred})` : "")
    );
  } else {
    logger.info(
      "[EVM-RPC] No managed RPC providers configured. " +
        "Using per-chain custom RPC URLs (ETHEREUM_PROVIDER_<CHAIN> / EVM_PROVIDER_<CHAIN>) or viem defaults."
    );
  }

  return {
    resolveForChain(chainName: string): ResolvedRPCProvider | null {
      const customRpc =
        getStringSetting(runtime, `ETHEREUM_PROVIDER_${chainName.toUpperCase()}`) ??
        getStringSetting(runtime, `EVM_PROVIDER_${chainName.toUpperCase()}`);

      if (customRpc) {
        return {
          providerName: "alchemy" as RPCProviderName,
          rpcUrl: customRpc,
          headers: {},
        };
      }

      for (const provider of providers) {
        if (!provider.supportedChains.has(chainName)) continue;
        const url = provider.buildUrl(chainName, provider.apiKey);
        if (!url) continue;

        const headers: Record<string, string> = {};
        if (provider.name === "elizacloud") {
          headers.Authorization = `Bearer ${provider.apiKey}`;
        }

        return {
          providerName: provider.name,
          rpcUrl: url,
          headers,
        };
      }

      return null;
    },

    getConfiguredProviders(): RPCProviderName[] {
      return providers.map((p) => p.name);
    },

    getCoveredChains(): string[] {
      const chains = new Set<string>();
      for (const provider of providers) {
        for (const chain of provider.supportedChains) {
          chains.add(chain);
        }
      }
      return Array.from(chains);
    },

    isChainCovered(chainName: string): boolean {
      const hasCustom =
        hasStringSetting(runtime, `ETHEREUM_PROVIDER_${chainName.toUpperCase()}`) ||
        hasStringSetting(runtime, `EVM_PROVIDER_${chainName.toUpperCase()}`);
      return hasCustom || providers.some((p) => p.supportedChains.has(chainName));
    },
  };
}

export function validateRPCProviderConfig(runtime: IAgentRuntime): {
  valid: boolean;
  providers: RPCProviderName[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const configuredProviders: RPCProviderName[] = [];

  if (hasStringSetting(runtime, "ALCHEMY_API_KEY")) configuredProviders.push("alchemy");
  if (hasStringSetting(runtime, "INFURA_API_KEY")) configuredProviders.push("infura");
  if (hasStringSetting(runtime, "ANKR_API_KEY")) configuredProviders.push("ankr");
  if (hasCloudRpcAccess(runtime)) configuredProviders.push("elizacloud");

  // Check for any per-chain custom RPC URLs
  let hasCustomRpc = false;
  const settings = runtime.character?.settings;
  let chainsToCheck: string[] = ["mainnet", "base"];
  if (
    typeof settings === "object" &&
    settings !== null &&
    "chains" in settings &&
    typeof settings.chains === "object" &&
    settings.chains !== null &&
    "evm" in settings.chains &&
    Array.isArray(settings.chains.evm)
  ) {
    chainsToCheck = settings.chains.evm.filter(
      (chain): chain is string => typeof chain === "string"
    );
  }

  for (const chain of chainsToCheck) {
    if (
      hasStringSetting(runtime, `ETHEREUM_PROVIDER_${chain.toUpperCase()}`) ||
      hasStringSetting(runtime, `EVM_PROVIDER_${chain.toUpperCase()}`)
    ) {
      hasCustomRpc = true;
      break;
    }
  }

  if (configuredProviders.length === 0 && !hasCustomRpc) {
    warnings.push(
      "No RPC provider configured. Set at least one of: " +
        "ALCHEMY_API_KEY, INFURA_API_KEY, ANKR_API_KEY, " +
        "ELIZAOS_CLOUD_API_KEY from an Eliza Cloud login, " +
        "or per-chain ETHEREUM_PROVIDER_<CHAIN> / EVM_PROVIDER_<CHAIN> URLs. " +
        "Falling back to public RPC endpoints (rate-limited, not recommended for production)."
    );
  }

  return {
    valid: configuredProviders.length > 0 || hasCustomRpc,
    providers: configuredProviders,
    warnings,
  };
}
