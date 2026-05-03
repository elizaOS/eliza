export interface ChainMeta {
  id: number;
  name: string;
  symbol: string;
  explorerUrl: string;
  explorerTxUrl: string;
  color: string; // for chain badge
}

export const CHAIN_META: Record<number, ChainMeta> = {
  1: {
    id: 1,
    name: "Ethereum",
    symbol: "ETH",
    explorerUrl: "https://etherscan.io",
    explorerTxUrl: "https://etherscan.io/tx/",
    color: "#627EEA",
  },
  56: {
    id: 56,
    name: "BSC",
    symbol: "BNB",
    explorerUrl: "https://bscscan.com",
    explorerTxUrl: "https://bscscan.com/tx/",
    color: "#F0B90B",
  },
  137: {
    id: 137,
    name: "Polygon",
    symbol: "POL",
    explorerUrl: "https://polygonscan.com",
    explorerTxUrl: "https://polygonscan.com/tx/",
    color: "#8247E5",
  },
  8453: {
    id: 8453,
    name: "Base",
    symbol: "ETH",
    explorerUrl: "https://basescan.org",
    explorerTxUrl: "https://basescan.org/tx/",
    color: "#0052FF",
  },
  42161: {
    id: 42161,
    name: "Arbitrum",
    symbol: "ETH",
    explorerUrl: "https://arbiscan.io",
    explorerTxUrl: "https://arbiscan.io/tx/",
    color: "#28A0F0",
  },
  101: {
    id: 101,
    name: "Solana",
    symbol: "SOL",
    explorerUrl: "https://explorer.solana.com",
    explorerTxUrl: "https://explorer.solana.com/tx/",
    color: "#9945FF",
  },
  102: {
    id: 102,
    name: "Solana Devnet",
    symbol: "SOL",
    explorerUrl: "https://explorer.solana.com",
    explorerTxUrl: "https://explorer.solana.com/tx/",
    color: "#9945FF",
  },
};

export function getChainMeta(chainId: number): ChainMeta | undefined {
  return CHAIN_META[chainId];
}

export function getExplorerTxLink(chainId: number, txHash: string): string | undefined {
  const meta = CHAIN_META[chainId];
  if (!meta) return undefined;
  if (chainId === 102) return `${meta.explorerTxUrl}${txHash}?cluster=devnet`;
  return `${meta.explorerTxUrl}${txHash}`;
}

export function getExplorerAddressLink(chainId: number, address: string): string | undefined {
  const meta = CHAIN_META[chainId];
  if (!meta) return undefined;
  if (chainId === 102) return `${meta.explorerUrl}/address/${address}?cluster=devnet`;
  return `${meta.explorerUrl}/address/${address}`;
}

export function getChainName(chainId: number): string {
  return CHAIN_META[chainId]?.name ?? `Chain ${chainId}`;
}

export function getChainSymbol(chainId: number): string {
  return CHAIN_META[chainId]?.symbol ?? "ETH";
}
