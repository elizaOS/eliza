import type { ChainProvider } from "./types.js";

export const polygon: ChainProvider = {
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
};
