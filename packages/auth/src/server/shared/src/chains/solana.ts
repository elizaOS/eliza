import type { ChainProvider } from "./types.js";

export const solana: ChainProvider = {
  caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  numericId: 101,
  family: "solana",
  name: "Solana",
  symbol: "SOL",
  testnet: false,
  explorerUrl: "https://explorer.solana.com",
  color: "#9945FF",
  explorerTxUrl: (h) => `https://explorer.solana.com/tx/${h}`,
  explorerAddressUrl: (a) => `https://explorer.solana.com/address/${a}`,
};

export const solanaDevnet: ChainProvider = {
  caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  numericId: 102,
  family: "solana",
  name: "Solana Devnet",
  symbol: "SOL",
  testnet: true,
  explorerUrl: "https://explorer.solana.com",
  color: "#9945FF",
  explorerTxUrl: (h) => `https://explorer.solana.com/tx/${h}?cluster=devnet`,
  explorerAddressUrl: (a) =>
    `https://explorer.solana.com/address/${a}?cluster=devnet`,
};
