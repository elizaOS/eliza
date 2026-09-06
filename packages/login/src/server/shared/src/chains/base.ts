import type { ChainProvider } from "./types.js";

export const base: ChainProvider = {
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
};

export const baseSepolia: ChainProvider = {
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
};
