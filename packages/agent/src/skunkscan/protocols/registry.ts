export type SolanaProtocol = {
  programId: string;
  name: string;
  category:
    | "dex"
    | "dex_aggregator"
    | "lending"
    | "staking"
    | "liquidity"
    | "bridge"
    | "nft"
    | "other";
};

const SOLANA_PROTOCOLS: Record<string, SolanaProtocol> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5NtH2K7QJ: {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5NtH2K7QJ",
    name: "Jupiter",
    category: "dex_aggregator",
  },

  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    name: "Raydium",
    category: "dex",
  },

  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: {
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    name: "Orca Whirlpool",
    category: "liquidity",
  },
};

export function lookupSolanaProtocol(
  programId: string | null | undefined,
): SolanaProtocol | null {
  if (!programId) {
    return null;
  }

  return SOLANA_PROTOCOLS[programId] ?? null;
}
