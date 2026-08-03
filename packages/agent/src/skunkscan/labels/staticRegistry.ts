import { WalletLabel } from "../types";

const STATIC_SOLANA_LABELS: Record<string, WalletLabel> = {
  "11111111111111111111111111111111": {
    address: "11111111111111111111111111111111",
    label: "Solana System Program",
    category: "system_program",
    confidence: "high",
    source: "static_registry",
  },

  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: {
    address:
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    label: "Solana Token Program",
    category: "token_program",
    confidence: "high",
    source: "static_registry",
  },

  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: {
    address:
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    label: "Solana Token-2022 Program",
    category: "token_program",
    confidence: "high",
    source: "static_registry",
  },

  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: {
    address:
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    label: "Solana Associated Token Account Program",
    category: "token_program",
    confidence: "high",
    source: "static_registry",
  },

  ComputeBudget111111111111111111111111111111: {
    address:
      "ComputeBudget111111111111111111111111111111",
    label: "Solana Compute Budget Program",
    category: "system_program",
    confidence: "high",
    source: "static_registry",
  },

  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: {
    address:
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    label: "Solana Memo Program",
    category: "system_program",
    confidence: "high",
    source: "static_registry",
  },

  Stake11111111111111111111111111111111111111: {
    address:
      "Stake11111111111111111111111111111111111111",
    label: "Solana Stake Program",
    category: "staking",
    confidence: "high",
    source: "static_registry",
  },

  Vote111111111111111111111111111111111111111: {
    address:
      "Vote111111111111111111111111111111111111111",
    label: "Solana Vote Program",
    category: "system_program",
    confidence: "high",
    source: "static_registry",
  },

  AddressLookupTab1e1111111111111111111111111: {
    address:
      "AddressLookupTab1e1111111111111111111111111",
    label: "Solana Address Lookup Table Program",
    category: "system_program",
    confidence: "high",
    source: "static_registry",
  },

  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": {
    address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
    label: "Binance 2",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },
};

export function lookupStaticSolanaWalletLabel(
  address: string | null | undefined,
): WalletLabel | null {
  if (!address) {
    return null;
  }

  return STATIC_SOLANA_LABELS[address] ?? null;
}

// Ethereum addresses are stored lowercase, same convention as the DeFi
// protocol and exposure registries: EIP-55 checksum casing is
// display-only. lookupStaticEthereumWalletLabel() below does an exact
// string match with no normalization of its own.
//
// FIXME: neither funding.ts's funding-counterparty address nor
// relationships.ts's counterparty addresses are lowercased before
// reaching lookupWalletLabel() today, so real matches against this
// registry will silently miss until that's fixed - needs its own
// follow-up PR, scoped to chain === "ethereum" only (Solana addresses
// are base58 and case-sensitive, so blanket-lowercasing would corrupt
// Solana label lookups). Flagged, not fixed here.
const STATIC_ETHEREUM_LABELS: Record<string, WalletLabel> = {
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": {
    address: "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
    label: "Coinbase 1",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },

  "0x3cd751e6b0078be393132286c442345e5dc49699": {
    address: "0x3cd751e6b0078be393132286c442345e5dc49699",
    label: "Coinbase 4",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },

  "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8": {
    address: "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8",
    label: "Binance 7",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },

  "0xf977814e90da44bfa03b6295a0616a897441acec": {
    address: "0xf977814e90da44bfa03b6295a0616a897441acec",
    label: "Binance: Hot Wallet 20",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },

  "0x28c6c06298d514db089934071355e5743bf21d60": {
    address: "0x28c6c06298d514db089934071355e5743bf21d60",
    label: "Binance 14",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },

  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": {
    address: "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0",
    label: "Kraken 4",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },

  "0x000000000000000000000000000000000000dead": {
    address: "0x000000000000000000000000000000000000dead",
    label: "Null: 0x00...dEaD (burn address)",
    category: "burn_address",
    confidence: "high",
    source: "static_registry",
  },

  "0x0000000000000000000000000000000000000000": {
    address: "0x0000000000000000000000000000000000000000",
    label: "Null: 0x000...000 (genesis/null address)",
    category: "burn_address",
    confidence: "high",
    source: "static_registry",
  },
};

export function lookupStaticEthereumWalletLabel(
  address: string | null | undefined,
): WalletLabel | null {
  if (!address) {
    return null;
  }

  return STATIC_ETHEREUM_LABELS[address] ?? null;
}
