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
};
