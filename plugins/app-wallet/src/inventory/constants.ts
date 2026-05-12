export const BSC_GAS_READY_THRESHOLD = 0.005;
export const BSC_GAS_THRESHOLD = 0.005;
export const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface TokenRow {
  chain: string;
  symbol: string;
  name: string;
  contractAddress: string | null;
  logoUrl: string | null;
  balance: string;
  valueUsd: number;
  balanceRaw: number;
  isNative: boolean;
}

export interface NftItem {
  chain: string;
  name: string;
  imageUrl: string;
  collectionName: string;
}

export function chainIcon(chain: string): { code: string; cls: string } {
  const c = chain.toLowerCase();
  if (c === "ethereum" || c === "mainnet")
    return { code: "E", cls: "bg-chain-eth" };
  if (c === "base") return { code: "B", cls: "bg-chain-base" };
  if (c === "bsc" || c === "bnb chain" || c === "bnb smart chain")
    return { code: "B", cls: "bg-chain-bsc" };
  if (
    c === "avax" ||
    c === "avalanche" ||
    c === "c-chain" ||
    c === "avalanche c-chain"
  )
    return { code: "A", cls: "bg-chain-avax" };
  if (c === "arbitrum") return { code: "A", cls: "bg-chain-arb" };
  if (c === "optimism") return { code: "O", cls: "bg-chain-op" };
  if (c === "polygon") return { code: "P", cls: "bg-chain-pol" };
  if (c === "solana") return { code: "S", cls: "bg-chain-sol" };
  return { code: chain.charAt(0).toUpperCase(), cls: "bg-bg-muted" };
}

export function normalizeChainName(chain: string): string {
  return chain.trim().toLowerCase();
}

export function isBscChainName(chain: string): boolean {
  const c = normalizeChainName(chain);
  return c === "bsc" || c === "bnb chain" || c === "bnb smart chain";
}

export function isAvaxChainName(chain: string): boolean {
  const c = normalizeChainName(chain);
  return (
    c === "avax" ||
    c === "avalanche" ||
    c === "c-chain" ||
    c === "avalanche c-chain"
  );
}

export function formatBalance(balance: string): string {
  const num = Number.parseFloat(balance);
  if (Number.isNaN(num)) return balance;
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  if (num < 1) return num.toFixed(6);
  if (num < 1000) return num.toFixed(4);
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function toNormalizedAddress(addr: string): string {
  return addr.trim().toLowerCase();
}
