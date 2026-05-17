/**
 * Central chain configuration registry.
 *
 * Every chain-specific constant (explorer URLs, native token details,
 * gas thresholds, stablecoin addresses, logo URLs, address validation)
 * lives here so that UI components and hooks can derive values from
 * a single source of truth rather than scattering inline constants.
 */

export type ChainKey =
  | "bsc"
  | "avax"
  | "solana"
  | "ethereum"
  | "base"
  | "arbitrum"
  | "optimism"
  | "polygon";

export interface Stablecoin {
  symbol: string;
  address: string;
}

export interface ChainConfig {
  /** Unique identifier used as filter key and in storage keys. */
  chainKey: ChainKey;
  /** Human-readable chain name. */
  name: string;
  /** Native gas-token symbol (e.g. BNB, AVAX, SOL). */
  nativeSymbol: string;
  /** Native token decimals. */
  nativeDecimals: number;
  /** Whether this is an EVM-compatible chain. */
  isEvm: boolean;

  /** Base URL of the chain's block explorer. */
  explorerBaseUrl: string;
  /** Path template for token pages; `{address}` is replaced. */
  explorerTokenPath: string;
  /** Path template for transaction pages; `{hash}` is replaced. */
  explorerTxPath: string;

  /** URL for the native gas-token logo. */
  nativeLogoUrl: string;
  /** TrustWallet assets CDN slug (e.g. `smartchain`, `avalanchec`). */
  trustWalletSlug: string | null;

  /** Minimum native balance to consider the wallet "trade-ready". */
  gasReadyThreshold: number;
  /** Reserve kept aside from max-balance swaps. */
  swapGasReserve: number;

  /** Well-known stablecoin contract addresses on this chain. */
  stablecoins: Stablecoin[];

  /** Regex to validate an address on this chain. */
  addressRegex: RegExp;

  /** Chain ID used by the DexScreener API. */
  dexScreenerChainId: string;

  /** Alternative chain name strings that resolve to this config. */
  nameVariants: string[];

  /** Brand color for the chain. CSS variable reference (e.g. `"var(--color-chain-eth)"`). */
  color: string;
}

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const CHAIN_CONFIGS: Record<ChainKey, ChainConfig> = {
  bsc: {
    chainKey: "bsc",
    name: "BSC",
    nativeSymbol: "BNB",
    nativeDecimals: 18,
    isEvm: true,
    explorerBaseUrl: "https://bscscan.com",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png",
    trustWalletSlug: "smartchain",
    gasReadyThreshold: 0.005,
    swapGasReserve: 0.002,
    stablecoins: [
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
    ],
    addressRegex: HEX_ADDRESS_RE,
    dexScreenerChainId: "bsc",
    nameVariants: ["bsc", "bnb chain", "bnb smart chain"],
    color: "var(--color-chain-bsc)",
  },

  avax: {
    chainKey: "avax",
    name: "Avalanche",
    nativeSymbol: "AVAX",
    nativeDecimals: 18,
    isEvm: true,
    explorerBaseUrl: "https://snowtrace.io",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/avalanchec/info/logo.png",
    trustWalletSlug: "avalanchec",
    gasReadyThreshold: 0.01,
    swapGasReserve: 0.005,
    stablecoins: [
      { symbol: "USDT", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7" },
      { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
    ],
    addressRegex: HEX_ADDRESS_RE,
    dexScreenerChainId: "avalanche",
    nameVariants: ["avax", "avalanche", "c-chain", "avalanche c-chain"],
    color: "#e84142",
  },

  solana: {
    chainKey: "solana",
    name: "Solana",
    nativeSymbol: "SOL",
    nativeDecimals: 9,
    isEvm: false,
    explorerBaseUrl: "https://solscan.io",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
    trustWalletSlug: "solana",
    gasReadyThreshold: 0.01,
    swapGasReserve: 0.005,
    stablecoins: [
      {
        symbol: "USDC",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    ],
    addressRegex: SOLANA_ADDRESS_RE,
    dexScreenerChainId: "solana",
    nameVariants: ["solana", "sol"],
    color: "var(--color-chain-sol)",
  },

  ethereum: {
    chainKey: "ethereum",
    name: "Ethereum",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isEvm: true,
    explorerBaseUrl: "https://etherscan.io",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    trustWalletSlug: "ethereum",
    gasReadyThreshold: 0.005,
    swapGasReserve: 0.002,
    stablecoins: [
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    ],
    addressRegex: HEX_ADDRESS_RE,
    dexScreenerChainId: "ethereum",
    nameVariants: ["ethereum", "mainnet", "eth"],
    color: "var(--color-chain-eth)",
  },

  base: {
    chainKey: "base",
    name: "Base",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isEvm: true,
    explorerBaseUrl: "https://basescan.org",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png",
    trustWalletSlug: "base",
    gasReadyThreshold: 0.005,
    swapGasReserve: 0.001,
    stablecoins: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    ],
    addressRegex: HEX_ADDRESS_RE,
    dexScreenerChainId: "base",
    nameVariants: ["base"],
    color: "var(--color-chain-base)",
  },

  arbitrum: {
    chainKey: "arbitrum",
    name: "Arbitrum",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isEvm: true,
    explorerBaseUrl: "https://arbiscan.io",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    trustWalletSlug: null,
    gasReadyThreshold: 0.005,
    swapGasReserve: 0.001,
    stablecoins: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    ],
    addressRegex: HEX_ADDRESS_RE,
    dexScreenerChainId: "arbitrum",
    nameVariants: ["arbitrum"],
    color: "var(--color-chain-arb)",
  },

  optimism: {
    chainKey: "optimism",
    name: "Optimism",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    isEvm: true,
    explorerBaseUrl: "https://optimistic.etherscan.io",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    trustWalletSlug: null,
    gasReadyThreshold: 0.005,
    swapGasReserve: 0.001,
    stablecoins: [
      { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
    ],
    addressRegex: HEX_ADDRESS_RE,
    dexScreenerChainId: "optimism",
    nameVariants: ["optimism"],
    color: "var(--color-chain-op)",
  },

  polygon: {
    chainKey: "polygon",
    name: "Polygon",
    nativeSymbol: "MATIC",
    nativeDecimals: 18,
    isEvm: true,
    explorerBaseUrl: "https://polygonscan.com",
    explorerTokenPath: "/token/{address}",
    explorerTxPath: "/tx/{hash}",
    nativeLogoUrl:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/info/logo.png",
    trustWalletSlug: "polygon",
    gasReadyThreshold: 0.5,
    swapGasReserve: 0.1,
    stablecoins: [
      { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
      { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
    ],
    addressRegex: HEX_ADDRESS_RE,
    dexScreenerChainId: "polygon",
    nameVariants: ["polygon"],
    color: "var(--color-chain-pol)",
  },
};

/** Pre-built lookup table from lowercase variant to ChainConfig. */
const _variantMap = new Map<string, ChainConfig>();
for (const config of Object.values(CHAIN_CONFIGS)) {
  for (const variant of config.nameVariants) {
    _variantMap.set(variant.toLowerCase(), config);
  }
}

/** Resolve a chain name (case-insensitive, trimmed) to its config. */
export function getChainConfig(chainName: string): ChainConfig | null {
  return _variantMap.get(chainName.trim().toLowerCase()) ?? null;
}

/**
 * Resolve a chain name string to a `ChainKey`.
 * Returns `null` for unrecognised chains.
 */
export function resolveChainKey(chainName: string): ChainKey | null {
  const config = getChainConfig(chainName);
  return config?.chainKey ?? null;
}

/**
 * Build the explorer URL for a token on the given chain.
 * Returns `null` if the chain is unknown or the address is invalid.
 */
export function getExplorerTokenUrl(
  chainName: string,
  address: string,
): string | null {
  const config = getChainConfig(chainName);
  if (!config) return null;
  const trimmed = address.trim();
  if (!config.addressRegex.test(trimmed)) return null;
  return `${config.explorerBaseUrl}${config.explorerTokenPath.replace("{address}", trimmed)}`;
}

/**
 * Build the explorer URL for a transaction on the given chain.
 * Returns `null` if the chain is unknown.
 */
export function getExplorerTxUrl(
  chainName: string,
  hash: string,
): string | null {
  const config = getChainConfig(chainName);
  if (!config) return null;
  return `${config.explorerBaseUrl}${config.explorerTxPath.replace("{hash}", hash.trim())}`;
}

/**
 * Get the native token logo URL for a chain, or `null` if unknown.
 */
export function getNativeLogoUrl(chainName: string): string | null {
  return getChainConfig(chainName)?.nativeLogoUrl ?? null;
}

/**
 * Get the TrustWallet CDN logo URL for a contract token on the given chain.
 * Returns `null` if the chain has no TrustWallet slug or no contract address.
 */
export function getContractLogoUrl(
  chainName: string,
  contractAddress: string | null,
): string | null {
  if (!contractAddress) return null;
  const config = getChainConfig(chainName);
  if (!config?.trustWalletSlug) return null;
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${config.trustWalletSlug}/assets/${contractAddress}/logo.png`;
}

/**
 * Resolve a stablecoin address on a given chain by symbol.
 * Returns `null` if not found.
 */
export function getStablecoinAddress(
  chainName: string,
  symbol: string,
): string | null {
  const config = getChainConfig(chainName);
  if (!config) return null;
  const upper = symbol.trim().toUpperCase();
  return config.stablecoins.find((s) => s.symbol === upper)?.address ?? null;
}

/** The primary chains we want to support prominently. */
export const PRIMARY_CHAIN_KEYS: ChainKey[] = [
  "ethereum",
  "base",
  "bsc",
  "avax",
  "solana",
];

/**
 * Map a chain focus key (ChainKey or "all") to the legacy WalletRpcChain used
 * by legacyCustomChains. Returns null for "all" or unknown chains.
 */
export function chainKeyToWalletRpcChain(
  chainFocus: string,
): "evm" | "bsc" | "solana" | null {
  if (chainFocus === "all" || chainFocus === "multi") return null;
  if (chainFocus === "bsc" || chainFocus === "solana") return chainFocus;
  const evmKeys: ChainKey[] = [
    "ethereum",
    "base",
    "avax",
    "arbitrum",
    "optimism",
    "polygon",
  ];
  return evmKeys.includes(chainFocus as ChainKey) ? "evm" : null;
}
