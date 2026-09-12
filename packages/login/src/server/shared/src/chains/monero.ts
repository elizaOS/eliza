import type { ChainProvider } from "./types.js";

/**
 * Monero has no finalized CAIP-2 namespace; `monero:mainnet` / `monero:stagenet`
 * is the in-repo convention (mirrors how bitcoin uses the bip122 genesis-hash
 * form as an internal identifier). Numeric IDs follow the non-EVM block
 * convention: solana 101/102, bitcoin 201/202, monero 301/302.
 */
export const monero: ChainProvider = {
  caip2: "monero:mainnet",
  numericId: 301,
  family: "monero",
  name: "Monero",
  symbol: "XMR",
  testnet: false,
  explorerUrl: "https://xmrchain.net",
  color: "#FF6600",
  explorerTxUrl: (h) => `https://xmrchain.net/tx/${h}`,
  explorerAddressUrl: (a) => `https://xmrchain.net/search?value=${a}`,
};

export const moneroStagenet: ChainProvider = {
  caip2: "monero:stagenet",
  numericId: 302,
  family: "monero",
  name: "Monero Stagenet",
  symbol: "XMR",
  testnet: true,
  explorerUrl: "https://stagenet.xmrchain.net",
  color: "#FF6600",
  explorerTxUrl: (h) => `https://stagenet.xmrchain.net/tx/${h}`,
  explorerAddressUrl: (a) => `https://stagenet.xmrchain.net/search?value=${a}`,
};
