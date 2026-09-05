import type { ChainProvider } from "./types.js";

export const gnosis: ChainProvider = {
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
};
