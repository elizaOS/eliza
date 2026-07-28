import { SupportedChain } from "../types";
import { SOLANA_DEX_PROTOCOLS } from "./solana/dex";
import { SOLANA_LAUNCHPAD_PROTOCOLS } from "./solana/launchpad";
import { SOLANA_LENDING_PROTOCOLS } from "./solana/lending";
import { SOLANA_STAKING_PROTOCOLS } from "./solana/staking";

export type ChainProtocol = {
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

const SOLANA_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  ...SOLANA_DEX_PROTOCOLS,
  ...SOLANA_LAUNCHPAD_PROTOCOLS,
  ...SOLANA_LENDING_PROTOCOLS,
  ...SOLANA_STAKING_PROTOCOLS,
};

const CHAIN_PROTOCOL_REGISTRIES: Partial<
  Record<SupportedChain, Readonly<Record<string, ChainProtocol>>>
> = {
  solana: SOLANA_PROTOCOLS,
};

export function lookupProtocol(
  chain: SupportedChain,
  programOrContractId: string | null | undefined,
): ChainProtocol | null {
  if (!programOrContractId) {
    return null;
  }

  const registry = CHAIN_PROTOCOL_REGISTRIES[chain];

  if (!registry) {
    return null;
  }

  return registry[programOrContractId] ?? null;
}
