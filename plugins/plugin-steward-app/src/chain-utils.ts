/**
 * Chain utilities for displaying chain names, symbols, and block explorer links.
 */

interface ChainMeta {
  name: string;
  symbol: string;
  explorerBase: string;
}

const CHAIN_MAP: Record<number, ChainMeta> = {
  1: { name: "Ethereum", symbol: "ETH", explorerBase: "https://etherscan.io" },
  56: { name: "BSC", symbol: "BNB", explorerBase: "https://bscscan.com" },
  97: {
    name: "BSC Testnet",
    symbol: "tBNB",
    explorerBase: "https://testnet.bscscan.com",
  },
  137: {
    name: "Polygon",
    symbol: "POL",
    explorerBase: "https://polygonscan.com",
  },
  8453: { name: "Base", symbol: "ETH", explorerBase: "https://basescan.org" },
  42161: {
    name: "Arbitrum",
    symbol: "ETH",
    explorerBase: "https://arbiscan.io",
  },
  84532: {
    name: "Base Sepolia",
    symbol: "ETH",
    explorerBase: "https://sepolia.basescan.org",
  },
  101: { name: "Solana", symbol: "SOL", explorerBase: "https://solscan.io" },
  102: {
    name: "Solana Devnet",
    symbol: "SOL",
    explorerBase: "https://solscan.io",
  },
};

export function getChainName(chainId: number): string {
  return CHAIN_MAP[chainId]?.name ?? `Chain ${chainId}`;
}

export function getChainSymbol(chainId: number): string {
  return CHAIN_MAP[chainId]?.symbol ?? "???";
}

export function getExplorerTxUrl(
  chainId: number,
  txHash: string,
): string | null {
  const meta = CHAIN_MAP[chainId];
  if (!meta || !txHash) return null;
  if (chainId === 101 || chainId === 102) {
    return `${meta.explorerBase}/tx/${txHash}${chainId === 102 ? "?cluster=devnet" : ""}`;
  }
  return `${meta.explorerBase}/tx/${txHash}`;
}

export function getExplorerAddressUrl(
  chainId: number,
  address: string,
): string | null {
  const meta = CHAIN_MAP[chainId];
  if (!meta || !address) return null;
  if (chainId === 101 || chainId === 102) {
    return `${meta.explorerBase}/account/${address}${chainId === 102 ? "?cluster=devnet" : ""}`;
  }
  return `${meta.explorerBase}/address/${address}`;
}

export function truncateAddress(address: string, chars = 6): string {
  if (!address || address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

export function formatWeiValue(weiStr: string, chainId: number): string {
  try {
    const wei = BigInt(weiStr);
    const isSolana = chainId === 101 || chainId === 102;
    const decimals = isSolana ? 9 : 18;
    const divisor = BigInt(10 ** decimals);
    const whole = wei / divisor;
    const frac = wei % divisor;
    const fracStr = frac
      .toString()
      .padStart(decimals, "0")
      .slice(0, 6)
      .replace(/0+$/, "");
    const symbol = getChainSymbol(chainId);
    return `${whole}${fracStr ? `.${fracStr}` : ""} ${symbol}`;
  } catch {
    return `${weiStr} wei`;
  }
}
