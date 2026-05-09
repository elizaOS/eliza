import {
  DEFAULT_WALLET_RPC_SELECTIONS,
  isElizaCloudServiceSelectedInConfig,
  migrateLegacyRuntimeConfig,
  normalizeWalletRpcSelections,
  type WalletConfigUpdateRequest,
  type WalletRpcChain,
  type WalletRpcCredentialKey,
  type WalletRpcSelections,
} from "@elizaos/core";

type ElizaConfig = Record<string, unknown> & {
  cloud?: (Record<string, unknown> & {
    apiKey?: string | null;
    baseUrl?: string | null;
  }) | null;
  env?: Record<string, unknown> | null;
};

export const DEFAULT_CLOUD_API_BASE_URL = "https://elizacloud.ai/api/v1";
// Multiple BSC public RPCs so we have working fallbacks when Eliza
// Cloud's proxy returns 401 (plan/account issue) AND the primary
// Binance dataseed endpoint is blocked/rate-limited. Order matters —
// the wallet resolver tries them in sequence, so put the most reliable
// community endpoints first.
export const DEFAULT_PUBLIC_BSC_RPC_URLS = [
  "https://bsc.publicnode.com/",
  "https://bsc-rpc.publicnode.com/",
  "https://binance.llamarpc.com/",
  "https://rpc.ankr.com/bsc",
  "https://bsc-dataseed.bnbchain.org/",
  "https://bsc-dataseed1.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/",
] as const;
export const DEFAULT_PUBLIC_BSC_TESTNET_RPC_URLS = [
  "https://bsc-testnet.publicnode.com/",
  "https://bsc-testnet-rpc.publicnode.com/",
  "https://data-seed-prebsc-1-s1.binance.org:8545/",
] as const;
// Same reasoning for Ethereum / Base / Avalanche — give the resolver
// multiple community endpoints so a single DNS/rate-limit failure
// doesn't block wallet execution end-to-end.
export const DEFAULT_PUBLIC_ETHEREUM_RPC_URLS = [
  "https://ethereum.publicnode.com/",
  "https://ethereum-rpc.publicnode.com/",
  "https://eth.llamarpc.com/",
  "https://rpc.ankr.com/eth",
] as const;
export const DEFAULT_PUBLIC_BASE_RPC_URLS = [
  "https://base.publicnode.com/",
  "https://base-rpc.publicnode.com/",
  "https://base.llamarpc.com/",
  "https://mainnet.base.org/",
] as const;
export const DEFAULT_PUBLIC_AVALANCHE_RPC_URLS = [
  "https://avalanche.publicnode.com/ext/bc/C/rpc",
  "https://avalanche-c-chain-rpc.publicnode.com/",
  "https://api.avax.network/ext/bc/C/rpc",
  "https://rpc.ankr.com/avalanche",
] as const;
export const DEFAULT_PUBLIC_SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;
export const DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS = [
  "https://api.devnet.solana.com",
] as const;

type WalletCapableConfig = Pick<ElizaConfig, "cloud" | "env"> & {
  wallet?: {
    rpcProviders?: Partial<Record<keyof WalletRpcSelections, string>>;
    network?: "mainnet" | "testnet";
  };
};

export interface InventoryProviderOption {
  id: WalletRpcChain;
  name: string;
  description: string;
  rpcProviders: Array<{
    id: string;
    name: string;
    description: string;
    envKey: WalletRpcCredentialKey | null;
    requiresKey: boolean;
  }>;
}

export interface WalletRpcResolutionOptions {
  cloudManagedAccess?: boolean | null;
  cloudApiKey?: string | null;
  cloudBaseUrl?: string | null;
  walletNetwork?: "mainnet" | "testnet" | null;
}

export interface WalletRpcReadiness {
  walletNetwork: "mainnet" | "testnet";
  cloudManagedAccess: boolean;
  managedBscRpcReady: boolean;
  evmBalanceReady: boolean;
  solanaBalanceReady: boolean;
  selectedRpcProviders: WalletRpcSelections;
  legacyCustomChains: WalletRpcChain[];
  bscRpcUrls: string[];
  ethereumRpcUrls: string[];
  baseRpcUrls: string[];
  avalancheRpcUrls: string[];
  solanaRpcUrls: string[];
}

type SupportedCloudEvmRpcChain = "mainnet" | "base" | "bsc" | "avalanche";

const PROVIDER_CREDENTIAL_KEYS: Record<
  WalletRpcChain,
  Record<string, WalletRpcCredentialKey[]>
> = {
  evm: {
    "eliza-cloud": [],
    alchemy: ["ALCHEMY_API_KEY"],
    infura: ["INFURA_API_KEY"],
    ankr: ["ANKR_API_KEY"],
  },
  bsc: {
    "eliza-cloud": [],
    alchemy: ["ALCHEMY_API_KEY"],
    ankr: ["ANKR_API_KEY"],
    nodereal: ["NODEREAL_BSC_RPC_URL"],
    quicknode: ["QUICKNODE_BSC_RPC_URL"],
  },
  solana: {
    "eliza-cloud": [],
    "helius-birdeye": ["HELIUS_API_KEY", "BIRDEYE_API_KEY"],
  },
};

const LEGACY_CUSTOM_CHAIN_KEYS: Record<
  WalletRpcChain,
  WalletRpcCredentialKey[]
> = {
  evm: ["ETHEREUM_RPC_URL", "BASE_RPC_URL", "AVALANCHE_RPC_URL"],
  bsc: ["BSC_RPC_URL"],
  solana: ["SOLANA_RPC_URL"],
};

const WALLET_RPC_CONFIG_KEYS = [
  "ALCHEMY_API_KEY",
  "INFURA_API_KEY",
  "ANKR_API_KEY",
  "ETHEREUM_RPC_URL",
  "BASE_RPC_URL",
  "AVALANCHE_RPC_URL",
  "HELIUS_API_KEY",
  "BIRDEYE_API_KEY",
  "NODEREAL_BSC_RPC_URL",
  "QUICKNODE_BSC_RPC_URL",
  "BSC_RPC_URL",
  "SOLANA_RPC_URL",
] as const satisfies readonly WalletRpcCredentialKey[];

function normalizeSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveWalletNetworkMode(
  config?: WalletCapableConfig | null,
  fallback?: string | null,
): "mainnet" | "testnet" {
  const normalized = (
    fallback ??
    config?.wallet?.network ??
    process.env.ELIZA_WALLET_NETWORK ??
    ""
  )
    .trim()
    .toLowerCase();
  if (normalized === "testnet") return "testnet";
  return "mainnet";
}

function uniqueRpcUrls(
  ...groups: Array<ReadonlyArray<string | null | undefined>>
): string[] {
  return [
    ...new Set(
      groups
        .flat()
        .map((url) => normalizeRpcUrl(url))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

function hasStoredSelections(config?: WalletCapableConfig | null): boolean {
  const selections = config?.wallet?.rpcProviders;
  return Boolean(selections && Object.keys(selections).length > 0);
}

function inferSelectedRpcProviders(): WalletRpcSelections {
  return {
    evm: process.env.ALCHEMY_API_KEY?.trim()
      ? "alchemy"
      : process.env.INFURA_API_KEY?.trim()
        ? "infura"
        : process.env.ANKR_API_KEY?.trim()
          ? "ankr"
          : DEFAULT_WALLET_RPC_SELECTIONS.evm,
    bsc: process.env.NODEREAL_BSC_RPC_URL?.trim()
      ? "nodereal"
      : process.env.QUICKNODE_BSC_RPC_URL?.trim()
        ? "quicknode"
        : process.env.ALCHEMY_API_KEY?.trim()
          ? "alchemy"
          : process.env.ANKR_API_KEY?.trim()
            ? "ankr"
            : DEFAULT_WALLET_RPC_SELECTIONS.bsc,
    solana:
      process.env.HELIUS_API_KEY?.trim() || process.env.BIRDEYE_API_KEY?.trim()
        ? "helius-birdeye"
        : DEFAULT_WALLET_RPC_SELECTIONS.solana,
  };
}

function walletSelectionsUseElizaCloud(
  selections: WalletRpcSelections,
): boolean {
  return Object.values(selections).some(
    (provider) => provider === "eliza-cloud",
  );
}

function hasLegacyCustomChainUrl(chain: WalletRpcChain): boolean {
  return LEGACY_CUSTOM_CHAIN_KEYS[chain].some((key) =>
    Boolean(normalizeSecret(process.env[key])),
  );
}

function buildLegacyCustomChains(
  selections: WalletRpcSelections,
): WalletRpcChain[] {
  return (Object.keys(LEGACY_CUSTOM_CHAIN_KEYS) as WalletRpcChain[]).filter(
    (chain) =>
      selections[chain] === DEFAULT_WALLET_RPC_SELECTIONS[chain] &&
      hasLegacyCustomChainUrl(chain),
  );
}

export function normalizeRpcUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolveCloudApiBaseUrl(
  rawBaseUrl?: string | null,
): string | null {
  const candidate =
    normalizeSecret(rawBaseUrl ?? process.env.ELIZAOS_CLOUD_BASE_URL) ??
    DEFAULT_CLOUD_API_BASE_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    const normalizedBase = parsed.toString().replace(/\/+$/, "");
    return normalizedBase.endsWith("/api/v1")
      ? normalizedBase
      : `${normalizedBase}/api/v1`;
  } catch {
    return null;
  }
}

export function resolveCloudApiKey(
  config?: Pick<ElizaConfig, "cloud"> | null,
): string | null {
  return normalizeSecret(
    config?.cloud?.apiKey ?? process.env.ELIZAOS_CLOUD_API_KEY,
  );
}

function buildCloudRpcProxyUrl(
  pathname: string,
  options: WalletRpcResolutionOptions = {},
): string | null {
  const cloudApiKey = normalizeSecret(
    options.cloudApiKey ?? process.env.ELIZAOS_CLOUD_API_KEY,
  );
  const cloudManagedAccess = options.cloudManagedAccess ?? Boolean(cloudApiKey);
  if (!cloudManagedAccess || !cloudApiKey) {
    return null;
  }

  const cloudBaseUrl = resolveCloudApiBaseUrl(options.cloudBaseUrl);
  if (!cloudBaseUrl) {
    return null;
  }

  const url = new URL(
    pathname.replace(/^\/+/, ""),
    `${cloudBaseUrl.replace(/\/+$/, "")}/`,
  );
  url.searchParams.set("api_key", cloudApiKey);
  return normalizeRpcUrl(url.toString());
}

export function buildCloudEvmRpcUrl(
  chain: SupportedCloudEvmRpcChain,
  options: WalletRpcResolutionOptions = {},
): string | null {
  return buildCloudRpcProxyUrl(`proxy/evm-rpc/${chain}`, options);
}

export function buildCloudSolanaRpcUrl(
  options: WalletRpcResolutionOptions = {},
): string | null {
  return buildCloudRpcProxyUrl("proxy/solana-rpc", options);
}

export function hasElizaCloudRpcAccess(
  config?: WalletCapableConfig | null,
): boolean {
  const selectedRpcProviders = hasStoredSelections(config)
    ? getStoredWalletRpcSelections(config)
    : inferSelectedRpcProviders();
  return Boolean(
    resolveCloudApiKey(config) &&
      (walletSelectionsUseElizaCloud(selectedRpcProviders) ||
        isElizaCloudServiceSelectedInConfig(
          (config ?? {}) as Record<string, unknown>,
          "rpc",
        )),
  );
}

export function getStoredWalletRpcSelections(
  config?: WalletCapableConfig | null,
): WalletRpcSelections {
  return normalizeWalletRpcSelections(config?.wallet?.rpcProviders);
}

export function getInventoryProviderOptions(): InventoryProviderOption[] {
  return [
    {
      id: "evm",
      name: "EVM",
      description: "Ethereum, Base, Arbitrum, Optimism, Polygon.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "infura",
          name: "Infura",
          description: "Reliable EVM infrastructure.",
          envKey: "INFURA_API_KEY",
          requiresKey: true,
        },
        {
          id: "alchemy",
          name: "Alchemy",
          description: "Full-featured EVM data platform.",
          envKey: "ALCHEMY_API_KEY",
          requiresKey: true,
        },
        {
          id: "ankr",
          name: "Ankr",
          description: "Decentralized RPC provider.",
          envKey: "ANKR_API_KEY",
          requiresKey: true,
        },
      ],
    },
    {
      id: "bsc",
      name: "BSC",
      description: "BNB Smart Chain tokens, NFTs, and trades.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "alchemy",
          name: "Alchemy",
          description: "Managed BSC RPC via Alchemy.",
          envKey: "ALCHEMY_API_KEY",
          requiresKey: true,
        },
        {
          id: "ankr",
          name: "Ankr",
          description: "Decentralized BSC RPC provider.",
          envKey: "ANKR_API_KEY",
          requiresKey: true,
        },
        {
          id: "nodereal",
          name: "NodeReal",
          description: "Dedicated BSC RPC endpoint.",
          envKey: "NODEREAL_BSC_RPC_URL",
          requiresKey: true,
        },
        {
          id: "quicknode",
          name: "QuickNode",
          description: "Managed BSC RPC endpoint.",
          envKey: "QUICKNODE_BSC_RPC_URL",
          requiresKey: true,
        },
      ],
    },
    {
      id: "solana",
      name: "Solana",
      description: "Solana mainnet tokens and NFTs.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "helius-birdeye",
          name: "Helius + Birdeye",
          description: "Solana balances and NFT metadata.",
          envKey: "HELIUS_API_KEY",
          requiresKey: true,
        },
      ],
    },
  ];
}

export function resolveBscRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  const network = resolveWalletNetworkMode(undefined, options.walletNetwork);
  const cloudRpcUrl =
    network === "mainnet" ? buildCloudEvmRpcUrl("bsc", options) : null;
  const publicDefaults =
    network === "testnet"
      ? DEFAULT_PUBLIC_BSC_TESTNET_RPC_URLS
      : DEFAULT_PUBLIC_BSC_RPC_URLS;
  return uniqueRpcUrls(
    [
      process.env.BSC_TESTNET_RPC_URL,
      process.env.NODEREAL_BSC_RPC_URL,
      process.env.QUICKNODE_BSC_RPC_URL,
      process.env.BSC_RPC_URL,
      cloudRpcUrl,
    ],
    options.cloudManagedAccess ? publicDefaults : [],
  );
}

export function resolveEthereumRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [process.env.ETHEREUM_RPC_URL, buildCloudEvmRpcUrl("mainnet", options)],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_ETHEREUM_RPC_URLS : [],
  );
}

export function resolveBaseRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [process.env.BASE_RPC_URL, buildCloudEvmRpcUrl("base", options)],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_BASE_RPC_URLS : [],
  );
}

export function resolveAvalancheRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  return uniqueRpcUrls(
    [process.env.AVALANCHE_RPC_URL, buildCloudEvmRpcUrl("avalanche", options)],
    options.cloudManagedAccess ? DEFAULT_PUBLIC_AVALANCHE_RPC_URLS : [],
  );
}

export function resolveSolanaRpcUrls(
  options: WalletRpcResolutionOptions = {},
): string[] {
  const network = resolveWalletNetworkMode(undefined, options.walletNetwork);
  const cloudRpcUrl =
    network === "mainnet" ? buildCloudSolanaRpcUrl(options) : null;
  const publicDefaults =
    network === "testnet"
      ? DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS
      : DEFAULT_PUBLIC_SOLANA_RPC_URLS;
  return uniqueRpcUrls(
    [
      process.env.SOLANA_TESTNET_RPC_URL,
      process.env.SOLANA_RPC_URL,
      cloudRpcUrl,
    ],
    options.cloudManagedAccess ? publicDefaults : [],
  );
}

export function applyWalletRpcConfigUpdate(
  config: WalletCapableConfig,
  update: WalletConfigUpdateRequest,
): void {
  config.env ??= {};
  const env = config.env as Record<string, string>;
  const normalizedSelections = normalizeWalletRpcSelections(update.selections);
  const selectedCredentialKeys = new Set<WalletRpcCredentialKey>();

  for (const chain of Object.keys(normalizedSelections) as WalletRpcChain[]) {
    for (const key of PROVIDER_CREDENTIAL_KEYS[chain][
      normalizedSelections[chain]
    ]) {
      selectedCredentialKeys.add(key);
    }
  }

  config.wallet = {
    ...config.wallet,
    rpcProviders: normalizedSelections,
    network:
      update.walletNetwork === "testnet"
        ? "testnet"
        : update.walletNetwork === "mainnet"
          ? "mainnet"
          : config.wallet?.network,
  };

  if (
    update.walletNetwork === "testnet" ||
    update.walletNetwork === "mainnet"
  ) {
    env.ELIZA_WALLET_NETWORK = update.walletNetwork;
    process.env.ELIZA_WALLET_NETWORK = update.walletNetwork;
  }

  for (const key of WALLET_RPC_CONFIG_KEYS) {
    const value = update.credentials?.[key];
    if (typeof value === "string" && value.trim()) {
      const normalizedValue = value.trim();
      env[key] = normalizedValue;
      process.env[key] = normalizedValue;
      continue;
    }
    if (typeof value === "string" || !selectedCredentialKeys.has(key)) {
      delete env[key];
      delete process.env[key];
    }
  }

  const heliusKey = update.credentials?.HELIUS_API_KEY?.trim();
  if (heliusKey) {
    const solanaRpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    env.SOLANA_RPC_URL = solanaRpcUrl;
    process.env.SOLANA_RPC_URL = solanaRpcUrl;
  } else if (
    typeof update.credentials?.HELIUS_API_KEY === "string" &&
    typeof update.credentials?.SOLANA_RPC_URL !== "string"
  ) {
    delete env.SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
  }
}

export function resolveWalletRpcReadiness(
  config?: WalletCapableConfig | null,
): WalletRpcReadiness {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    migrateLegacyRuntimeConfig(config as Record<string, unknown>);
  }
  const walletNetwork = resolveWalletNetworkMode(config);
  const cloudApiKey = resolveCloudApiKey(config);
  const cloudBaseUrl = resolveCloudApiBaseUrl(config?.cloud?.baseUrl);
  const selectedRpcProviders = hasStoredSelections(config)
    ? getStoredWalletRpcSelections(config)
    : inferSelectedRpcProviders();
  const cloudRpcSelected =
    walletSelectionsUseElizaCloud(selectedRpcProviders) ||
    isElizaCloudServiceSelectedInConfig(
      (config ?? {}) as Record<string, unknown>,
      "rpc",
    );
  const cloudManagedAccess = Boolean(cloudApiKey && cloudRpcSelected);
  const cloudOptions = {
    cloudManagedAccess,
    cloudApiKey,
    cloudBaseUrl,
    walletNetwork,
  } satisfies WalletRpcResolutionOptions;
  const bscRpcUrls = resolveBscRpcUrls(cloudOptions);
  const ethereumRpcUrls = resolveEthereumRpcUrls(cloudOptions);
  const baseRpcUrls = resolveBaseRpcUrls(cloudOptions);
  const avalancheRpcUrls = resolveAvalancheRpcUrls(cloudOptions);
  const solanaRpcUrls = resolveSolanaRpcUrls(cloudOptions);
  const legacyCustomChains = buildLegacyCustomChains(selectedRpcProviders);

  return {
    walletNetwork,
    cloudManagedAccess,
    managedBscRpcReady: bscRpcUrls.length > 0,
    evmBalanceReady: Boolean(
      process.env.ALCHEMY_API_KEY?.trim() ||
        process.env.ANKR_API_KEY?.trim() ||
        process.env.INFURA_API_KEY?.trim() ||
        bscRpcUrls.length > 0 ||
        ethereumRpcUrls.length > 0 ||
        baseRpcUrls.length > 0 ||
        avalancheRpcUrls.length > 0,
    ),
    solanaBalanceReady: Boolean(
      process.env.HELIUS_API_KEY?.trim() || solanaRpcUrls.length > 0,
    ),
    selectedRpcProviders,
    legacyCustomChains,
    bscRpcUrls,
    ethereumRpcUrls,
    baseRpcUrls,
    avalancheRpcUrls,
    solanaRpcUrls,
  };
}
