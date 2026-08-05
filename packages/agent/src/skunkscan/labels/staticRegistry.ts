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
// display-only. lookupStaticEthereumWalletLabel() below lowercases its
// input before the lookup - safe to do unconditionally here (unlike
// lookupStaticExposure, which is chain-generic and uses isEvmChain())
// because this function is only ever called from labelEngine.ts's
// "ethereum" switch case; it never sees a Solana address, so there's no
// base58 case-sensitivity concern to guard against.
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

  return STATIC_ETHEREUM_LABELS[address.toLowerCase()] ?? null;
}

// Same unconditional-lowercase convention as
// lookupStaticEthereumWalletLabel() above, for the same reason: this
// function is only ever called from labelEngine.ts's "bnb" switch case,
// so it never sees a Solana address - no base58 case-sensitivity guard
// needed here (unlike lookupStaticExposure, which is chain-generic and
// uses isEvmChain()).
//
// Verified directly against BscScan: labeled "Binance: Hot Wallet 11",
// tagged "Binance"/"Exchange", 31,041,368 transactions.
const STATIC_BNB_LABELS: Record<string, WalletLabel> = {
  "0x161ba15a5f335c9f06bb5bbb0a9ce14076fbb645": {
    address: "0x161ba15a5f335c9f06bb5bbb0a9ce14076fbb645",
    label: "Binance: Hot Wallet 11",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },
};

export function lookupStaticBnbWalletLabel(
  address: string | null | undefined,
): WalletLabel | null {
  if (!address) {
    return null;
  }

  return STATIC_BNB_LABELS[address.toLowerCase()] ?? null;
}

// Same unconditional-lowercase convention as the functions above, for the
// same reason: only ever called from labelEngine.ts's "base" switch case.
//
// Verified directly against BaseScan: labeled "Coinbase 42", tagged as an
// exchange wallet, 884,350 transactions, 2,578+ ETH balance.
const STATIC_BASE_LABELS: Record<string, WalletLabel> = {
  "0x40ebc1ac8d4fedd2e144b75fe9c0420be82750c6": {
    address: "0x40ebc1ac8d4fedd2e144b75fe9c0420be82750c6",
    label: "Coinbase 42",
    category: "centralized_exchange",
    confidence: "high",
    source: "static_registry",
  },
};

export function lookupStaticBaseWalletLabel(
  address: string | null | undefined,
): WalletLabel | null {
  if (!address) {
    return null;
  }

  return STATIC_BASE_LABELS[address.toLowerCase()] ?? null;
}
