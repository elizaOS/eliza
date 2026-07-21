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
    | "perpetuals"
    | "yield"
    | "launchpad"
    | "stablecoin"
    | "infrastructure"
    | "other";

  reputation:
    | "high"
    | "medium"
    | "unknown";

  verified: boolean;

  custodial: boolean;

  deprecated: boolean;

  website?: string;

  notes?: string;

  tags: string[];
};

const SOLANA_PROTOCOLS: Readonly<Record<string, SolanaProtocol>> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5NtH2K7QJ: {
  programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5NtH2K7QJ",
  name: "Jupiter",
  category: "dex_aggregator",
  reputation: "high",
},

  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
  programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  name: "Raydium",
  category: "dex",
  reputation: "high",
},

  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: {
  programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  name: "Orca Whirlpool",
  category: "liquidity",
  reputation: "high",
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
