import type { ChainProvider } from "./types.js";

export const ethereum: ChainProvider = {
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
};
