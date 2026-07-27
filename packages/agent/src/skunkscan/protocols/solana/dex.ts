import { SolanaProtocol } from "../registry";

export const SOLANA_DEX_PROTOCOLS: Readonly<
  Record<string, SolanaProtocol>
> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    name: "Jupiter Aggregator V6",
    category: "dex_aggregator",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://jup.ag",
    notes: "Jupiter V6 swap aggregation program on Solana.",
    tags: [
      "jupiter",
      "dex-aggregator",
      "swap",
      "routing",
      "solana",
    ],
  },

  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: {
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    name: "Orca Whirlpool",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://orca.so",
    notes: "Official Orca concentrated liquidity AMM program.",
    tags: [
      "orca",
      "whirlpool",
      "amm",
      "dex",
      "liquidity",
      "solana",
    ],
  },

  srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX: {
    programId: "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
    name: "OpenBook V2",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://openbookdex.org",
    notes: "OpenBook central limit order book program.",
    tags: [
      "openbook",
      "clob",
      "dex",
      "orderbook",
      "solana",
    ],
  },

  CAMMCzo5YL8w4VFF8KVHrK22GGUQKJSibRGz6JrE4qK: {
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUQKJSibRGz6JrE4qK",
    name: "Raydium CLMM",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://raydium.io",
    notes: "Raydium concentrated liquidity market maker program.",
    tags: [
      "raydium",
      "clmm",
      "amm",
      "dex",
      "liquidity",
      "solana",
    ],
  },

  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    name: "Raydium AMM V4",
    category: "dex",
    reputation: "medium",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://raydium.io",
    notes:
      "Raydium's older constant-product AMM V4 program, alongside the newer Raydium CLMM program above. Program ID sourced from an internal dead-code file, not yet independently confirmed; reputation set to medium pending verification.",
    tags: [
      "raydium",
      "amm-v4",
      "amm",
      "dex",
      "liquidity",
      "solana",
    ],
  },
};
