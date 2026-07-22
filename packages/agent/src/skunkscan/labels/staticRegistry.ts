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
};

export function lookupStaticSolanaWalletLabel(
  address: string | null | undefined,
): WalletLabel | null {
  if (!address) {
    return null;
  }

  return STATIC_SOLANA_LABELS[address] ?? null;
}
