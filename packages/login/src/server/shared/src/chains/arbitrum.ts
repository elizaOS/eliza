import type { ChainProvider } from "./types.js";

export const arbitrum: ChainProvider = {
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
};
