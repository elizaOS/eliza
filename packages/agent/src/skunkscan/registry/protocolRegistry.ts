export type ProtocolCategory =
  | "dex"
  | "dex_aggregator"
  | "lending"
  | "staking"
  | "bridge"
  | "nft"
  | "liquidity"
  | "other";

export type ProtocolDefinition = {
  name: string;
  category: ProtocolCategory;
  reputation: "high" | "medium" | "unknown";
};

export const SOLANA_PROTOCOL_REGISTRY: Record<
  string,
  ProtocolDefinition
> = {
  // Jupiter
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    name: "Jupiter",
    category: "dex_aggregator",
    reputation: "high",
  },

  // Raydium
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    name: "Raydium",
    category: "dex",
    reputation: "high",
  },

  // Orca
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: {
    name: "Orca",
    category: "dex",
    reputation: "high",
  },

  // Marinade
  MarBmsSgKXdrN1egZf5sqe1TMjuQd6QnP7P6o9uY8Hh: {
    name: "Marinade",
    category: "staking",
    reputation: "high",
  },
};
