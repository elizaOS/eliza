import type { ChainProvider } from "./types.js";

export const bsc: ChainProvider = {
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
};

export const bscTestnet: ChainProvider = {
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
};
