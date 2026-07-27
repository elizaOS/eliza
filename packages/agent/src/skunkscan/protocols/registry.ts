import { SOLANA_DEX_PROTOCOLS } from "./solana/dex";
import { SOLANA_LAUNCHPAD_PROTOCOLS } from "./solana/launchpad";
import { SOLANA_LENDING_PROTOCOLS } from "./solana/lending";
import { SOLANA_STAKING_PROTOCOLS } from "./solana/staking";

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
  ...SOLANA_LAUNCHPAD_PROTOCOLS,
  ...SOLANA_LENDING_PROTOCOLS,
  ...SOLANA_STAKING_PROTOCOLS,
};

export function lookupSolanaProtocol(
  programId: string | null | undefined,
): SolanaProtocol | null {
  if (!programId) {
    return null;
  }

  return SOLANA_PROTOCOLS[programId] ?? null;
}
