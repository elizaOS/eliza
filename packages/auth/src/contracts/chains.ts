export type ChainFamily = "evm" | "solana" | "bitcoin" | "monero";

export interface ChainProvider {
  /** CAIP-2 identifier (e.g. "eip155:100"). */
  caip2: string;
  /** Internal numeric ID. For EVM chains this matches the chain ID. For
   * non-EVM chains this is a convention used to map back to CAIP-2. */
  numericId: number;
  /** Family/VM the chain belongs to. */
  family: ChainFamily;
  /** Human-readable display name. */
  name: string;
  /** Native asset ticker. */
  symbol: string;
  /** Whether this is a testnet. */
  testnet: boolean;
  /** Block-explorer base URL (no trailing slash). */
  explorerUrl: string;
  /** Brand color used by UI chain badges. */
  color: string;
  /** Function building the explorer URL for a transaction hash. */
  explorerTxUrl: (txHash: string) => string;
  /** Function building the explorer URL for an address. */
  explorerAddressUrl: (address: string) => string;
}

export const ethereum = {
  caip2: "eip155:1",
  numericId: 1,
  family: "evm",
  name: "Ethereum",
  symbol: "ETH",
  testnet: false,
  explorerUrl: "https://etherscan.io",
  color: "#627EEA",
  explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
  explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
} as const satisfies ChainProvider;

export const bsc = {
  caip2: "eip155:56",
  numericId: 56,
  family: "evm",
  name: "BSC",
  symbol: "BNB",
  testnet: false,
  explorerUrl: "https://bscscan.com",
  color: "#F0B90B",
  explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
  explorerAddressUrl: (a) => `https://bscscan.com/address/${a}`,
} as const satisfies ChainProvider;

export const bscTestnet = {
  caip2: "eip155:97",
  numericId: 97,
  family: "evm",
  name: "BSC Testnet",
  symbol: "tBNB",
  testnet: true,
  explorerUrl: "https://testnet.bscscan.com",
  color: "#F0B90B",
  explorerTxUrl: (h) => `https://testnet.bscscan.com/tx/${h}`,
  explorerAddressUrl: (a) => `https://testnet.bscscan.com/address/${a}`,
} as const satisfies ChainProvider;

export const gnosis = {
  caip2: "eip155:100",
  numericId: 100,
  family: "evm",
  name: "Gnosis",
  symbol: "xDAI",
  testnet: false,
  explorerUrl: "https://gnosisscan.io",
  color: "#04795B",
  explorerTxUrl: (h) => `https://gnosisscan.io/tx/${h}`,
  explorerAddressUrl: (a) => `https://gnosisscan.io/address/${a}`,
} as const satisfies ChainProvider;

export const polygon = {
  caip2: "eip155:137",
  numericId: 137,
  family: "evm",
  name: "Polygon",
  symbol: "POL",
  testnet: false,
  explorerUrl: "https://polygonscan.com",
  color: "#8247E5",
  explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
  explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
} as const satisfies ChainProvider;

export const base = {
  caip2: "eip155:8453",
  numericId: 8453,
  family: "evm",
  name: "Base",
  symbol: "ETH",
  testnet: false,
  explorerUrl: "https://basescan.org",
  color: "#0052FF",
  explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
  explorerAddressUrl: (a) => `https://basescan.org/address/${a}`,
} as const satisfies ChainProvider;

export const baseSepolia = {
  caip2: "eip155:84532",
  numericId: 84532,
  family: "evm",
  name: "Base Sepolia",
  symbol: "ETH",
  testnet: true,
  explorerUrl: "https://sepolia.basescan.org",
  color: "#0052FF",
  explorerTxUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
  explorerAddressUrl: (a) => `https://sepolia.basescan.org/address/${a}`,
} as const satisfies ChainProvider;

export const arbitrum = {
  caip2: "eip155:42161",
  numericId: 42161,
  family: "evm",
  name: "Arbitrum",
  symbol: "ETH",
  testnet: false,
  explorerUrl: "https://arbiscan.io",
  color: "#28A0F0",
  explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
  explorerAddressUrl: (a) => `https://arbiscan.io/address/${a}`,
} as const satisfies ChainProvider;

export const solana = {
  caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  numericId: 101,
  family: "solana",
  name: "Solana",
  symbol: "SOL",
  testnet: false,
  explorerUrl: "https://explorer.solana.com",
  color: "#9945FF",
  explorerTxUrl: (h) => `https://explorer.solana.com/tx/${h}`,
  explorerAddressUrl: (a) => `https://explorer.solana.com/address/${a}`,
} as const satisfies ChainProvider;

export const solanaDevnet = {
  caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  numericId: 102,
  family: "solana",
  name: "Solana Devnet",
  symbol: "SOL",
  testnet: true,
  explorerUrl: "https://explorer.solana.com",
  color: "#9945FF",
  explorerTxUrl: (h) => `https://explorer.solana.com/tx/${h}?cluster=devnet`,
  explorerAddressUrl: (a) =>
    `https://explorer.solana.com/address/${a}?cluster=devnet`,
} as const satisfies ChainProvider;

export const bitcoin = {
  caip2: "bip122:000000000019d6689c085ae165831e93",
  numericId: 201,
  family: "bitcoin",
  name: "Bitcoin",
  symbol: "BTC",
  testnet: false,
  explorerUrl: "https://mempool.space",
  color: "#F7931A",
  explorerTxUrl: (h) => `https://mempool.space/tx/${h}`,
  explorerAddressUrl: (a) => `https://mempool.space/address/${a}`,
} as const satisfies ChainProvider;

export const bitcoinTestnet = {
  caip2: "bip122:000000000933ea01ad0ee984209779ba",
  numericId: 202,
  family: "bitcoin",
  name: "Bitcoin Testnet",
  symbol: "BTC",
  testnet: true,
  explorerUrl: "https://mempool.space/testnet",
  color: "#F7931A",
  explorerTxUrl: (h) => `https://mempool.space/testnet/tx/${h}`,
  explorerAddressUrl: (a) => `https://mempool.space/testnet/address/${a}`,
} as const satisfies ChainProvider;

/**
 * Monero has no finalized CAIP-2 namespace; `monero:mainnet` / `monero:stagenet`
 * is the in-repo convention (mirrors how bitcoin uses the bip122 genesis-hash
 * form as an internal identifier). Numeric IDs follow the non-EVM block
 * convention: solana 101/102, bitcoin 201/202, monero 301/302.
 */
export const monero = {
  caip2: "monero:mainnet",
  numericId: 301,
  family: "monero",
  name: "Monero",
  symbol: "XMR",
  testnet: false,
  explorerUrl: "https://xmrchain.net",
  color: "#FF6600",
  explorerTxUrl: (h) => `https://xmrchain.net/tx/${h}`,
  explorerAddressUrl: (a) => `https://xmrchain.net/search?value=${a}`,
} as const satisfies ChainProvider;

export const moneroStagenet = {
  caip2: "monero:stagenet",
  numericId: 302,
  family: "monero",
  name: "Monero Stagenet",
  symbol: "XMR",
  testnet: true,
  explorerUrl: "https://stagenet.xmrchain.net",
  color: "#FF6600",
  explorerTxUrl: (h) => `https://stagenet.xmrchain.net/tx/${h}`,
  explorerAddressUrl: (a) => `https://stagenet.xmrchain.net/search?value=${a}`,
} as const satisfies ChainProvider;

/** All registered chain providers. Add new entries here. */
export const CHAIN_PROVIDERS: readonly ChainProvider[] = [
  ethereum,
  bsc,
  bscTestnet,
  polygon,
  gnosis,
  base,
  baseSepolia,
  arbitrum,
  solana,
  solanaDevnet,
  bitcoin,
  bitcoinTestnet,
  monero,
  moneroStagenet,
];

/** Lookup helpers built from the registry. */
export const CHAIN_PROVIDERS_BY_CAIP2: Record<string, ChainProvider> =
  Object.freeze(Object.fromEntries(CHAIN_PROVIDERS.map((c) => [c.caip2, c])));

export const CHAIN_PROVIDERS_BY_NUMERIC: Record<number, ChainProvider> =
  Object.freeze(
    Object.fromEntries(CHAIN_PROVIDERS.map((c) => [c.numericId, c])),
  );

export function getChainProviderByCaip2(
  caip2: string,
): ChainProvider | undefined {
  // Own-key lookup: a bare index would return Object.prototype members (e.g.
  // "constructor") as if they were known providers (SEC-116).
  return Object.hasOwn(CHAIN_PROVIDERS_BY_CAIP2, caip2)
    ? CHAIN_PROVIDERS_BY_CAIP2[caip2]
    : undefined;
}

export function getChainProviderByNumeric(
  numericId: number,
): ChainProvider | undefined {
  return CHAIN_PROVIDERS_BY_NUMERIC[numericId];
}

export interface ChainIdentifier {
  caip2: string;
  numericId: number;
  family: ChainFamily;
  name: string;
  symbol: string;
  testnet: boolean;
}

/** Chain identity records derived from the shared provider registry. */
export const CHAINS: Record<string, ChainIdentifier> = Object.freeze(
  Object.fromEntries(
    CHAIN_PROVIDERS.map((p: ChainProvider): [string, ChainIdentifier] => [
      p.caip2,
      {
        caip2: p.caip2,
        numericId: p.numericId,
        family: p.family,
        name: p.name,
        symbol: p.symbol,
        testnet: p.testnet,
      },
    ]),
  ),
);

/** Look up a chain by its internal numeric ID. Returns undefined if not found. */
export function chainFromNumeric(id: number): ChainIdentifier | undefined {
  return Object.values(CHAINS).find((c) => c.numericId === id);
}

/** Look up a chain by its CAIP-2 string (e.g. `"eip155:8453"`). Returns undefined if not found. */
export function chainFromCaip2(caip2: string): ChainIdentifier | undefined {
  // Own-key lookup: a bare index would return Object.prototype members (e.g.
  // "constructor") as if they were known chains (SEC-116).
  return Object.hasOwn(CHAINS, caip2) ? CHAINS[caip2] : undefined;
}

/**
 * Convert an internal numeric chain ID to its CAIP-2 string.
 * Returns undefined for unrecognised chain IDs.
 */
export function toCaip2(numericId: number): string | undefined {
  return chainFromNumeric(numericId)?.caip2;
}

/**
 * Convert a CAIP-2 string back to the internal numeric chain ID.
 * Returns undefined for unrecognised CAIP-2 strings.
 */
export function fromCaip2(caip2: string): number | undefined {
  return chainFromCaip2(caip2)?.numericId;
}

export const SUPPORTED_CHAINS = {
  ethereum: ethereum.numericId,
  bsc: bsc.numericId,
  bscTestnet: bscTestnet.numericId,
  gnosis: gnosis.numericId,
  polygon: polygon.numericId,
  base: base.numericId,
  baseSepolia: baseSepolia.numericId,
  arbitrum: arbitrum.numericId,
  solana: solana.numericId,
  solanaDevnet: solanaDevnet.numericId,
  bitcoin: bitcoin.numericId,
  bitcoinTestnet: bitcoinTestnet.numericId,
  monero: monero.numericId,
  moneroStagenet: moneroStagenet.numericId,
} as const;

export const DEFAULT_CHAIN_ID = SUPPORTED_CHAINS.base;

export interface ChainMeta {
  id: number;
  name: string;
  symbol: string;
  explorerUrl: string;
  explorerTxUrl: string; // append tx hash to this
}

export const CHAIN_META: Record<number, ChainMeta> = Object.freeze(
  Object.fromEntries(
    CHAIN_PROVIDERS.map((p) => [
      p.numericId,
      {
        id: p.numericId,
        name: p.name,
        symbol: p.symbol,
        explorerUrl: p.explorerUrl,
        explorerTxUrl: p.explorerTxUrl("").split("?")[0] ?? "",
      },
    ]),
  ),
);
export function getChainMeta(chainId: number): ChainMeta | undefined {
  return CHAIN_META[chainId];
}
export function getExplorerTxLink(
  chainId: number,
  txHash: string,
): string | undefined {
  return getChainProviderByNumeric(chainId)?.explorerTxUrl(txHash);
}
