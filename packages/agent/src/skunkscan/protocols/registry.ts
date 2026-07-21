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
  // =========================
  // DEX Aggregators
  // =========================

  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    name: "Jupiter",
    category: "dex_aggregator",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://jup.ag",
    notes: "Leading Solana DEX aggregator.",
    tags: ["dex", "aggregator", "swap", "routing"],
  },

  // =========================
  // DEXs and Liquidity
  // =========================

  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    name: "Raydium",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://raydium.io",
    notes: "AMM and liquidity protocol.",
    tags: ["dex", "amm", "swap", "liquidity"],
  },

  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": {
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    name: "Orca Whirlpool",
    category: "liquidity",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://orca.so",
    notes: "Concentrated liquidity AMM.",
    tags: ["dex", "amm", "liquidity", "concentrated-liquidity"],
  },

  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY": {
    programId: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
    name: "Phoenix",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://phoenix.trade",
    notes: "On-chain order-book exchange.",
    tags: ["dex", "orderbook", "trading"],
  },

  "srmqPvymJeFKQ4zGQed1GFppgkJj5rjLrM4P6hS1d5V": {
    programId: "srmqPvymJeFKQ4zGQed1GFppgkJj5rjLrM4P6hS1d5V",
    name: "OpenBook",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://openbookdex.org",
    notes: "Community-led order-book exchange.",
    tags: ["dex", "orderbook", "trading"],
  },

    "9xQeWvG816bUx9EPjHmaT23yvVMuYkM7s4M6mQjJxL8": {
    programId: "9xQeWvG816bUx9EPjHmaT23yvVMuYkM7s4M6mQjJxL8",
    name: "Serum",
    category: "dex",
    reputation: "medium",
    verified: true,
    custodial: false,
    deprecated: true,
    website: "https://projectserum.com",
    notes: "Historical protocol retained for forensic analysis.",
    tags: ["dex", "orderbook", "historical"],
  },

  // =========================
  // Lending & Staking
  // =========================

  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD": {
    programId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    name: "Kamino",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://kamino.finance",
    notes: "Lending, borrowing and vault protocol.",
    tags: ["lending", "borrowing", "vaults"],
  },

  "Marginfi111111111111111111111111111111111": {
    programId: "Marginfi111111111111111111111111111111111",
    name: "Marginfi",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://marginfi.com",
    notes: "Solana lending protocol.",
    tags: ["lending", "borrowing"],
  },

  "Marinade111111111111111111111111111111111": {
    programId: "Marinade111111111111111111111111111111111",
    name: "Marinade",
    category: "staking",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://marinade.finance",
    notes: "Liquid staking protocol.",
    tags: ["staking", "liquid-staking"],
  },

  "Jito11111111111111111111111111111111111111": {
    programId: "Jito11111111111111111111111111111111111111",
    name: "Jito",
    category: "staking",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://jito.network",
    notes: "Liquid staking and MEV ecosystem.",
    tags: ["staking", "liquid-staking", "mev"],
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
