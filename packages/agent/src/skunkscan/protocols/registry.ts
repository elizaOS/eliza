import { SOLANA_DEX_PROTOCOLS } from "./solana/dex";

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
  ...SOLANA_DEX_PROTOCOLS,
};

export function lookupSolanaProtocol(
  programId: string | null | undefined,
): SolanaProtocol | null {
  if (!programId) {
    return null;
  }

  return SOLANA_PROTOCOLS[programId] ?? null;
}
