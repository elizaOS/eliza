import type { ChainProvider } from "./types.js";

export const bitcoin: ChainProvider = {
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
};

export const bitcoinTestnet: ChainProvider = {
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
};
