import { SupportedChain } from "../types";
import { SOLANA_DEX_PROTOCOLS } from "./solana/dex";
import { SOLANA_LAUNCHPAD_PROTOCOLS } from "./solana/launchpad";
import { SOLANA_LENDING_PROTOCOLS } from "./solana/lending";
import { SOLANA_STAKING_PROTOCOLS } from "./solana/staking";
import { ETHEREUM_DEX_PROTOCOLS } from "./ethereum/dex";
import { ETHEREUM_LENDING_PROTOCOLS } from "./ethereum/lending";
import { ETHEREUM_STAKING_PROTOCOLS } from "./ethereum/staking";
import { ETHEREUM_YIELD_PROTOCOLS } from "./ethereum/yield";
import { ETHEREUM_NFT_PROTOCOLS } from "./ethereum/nft";
import { ETHEREUM_INFRASTRUCTURE_PROTOCOLS } from "./ethereum/infrastructure";
import { BNB_DEX_PROTOCOLS } from "./bnb/dex";
import { BNB_LENDING_PROTOCOLS } from "./bnb/lending";
import { BNB_STAKING_PROTOCOLS } from "./bnb/staking";
import { BNB_INFRASTRUCTURE_PROTOCOLS } from "./bnb/infrastructure";

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

const ETHEREUM_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  ...ETHEREUM_DEX_PROTOCOLS,
  ...ETHEREUM_LENDING_PROTOCOLS,
  ...ETHEREUM_STAKING_PROTOCOLS,
  ...ETHEREUM_YIELD_PROTOCOLS,
  ...ETHEREUM_NFT_PROTOCOLS,
  ...ETHEREUM_INFRASTRUCTURE_PROTOCOLS,
};

const BNB_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  ...BNB_DEX_PROTOCOLS,
  ...BNB_LENDING_PROTOCOLS,
  ...BNB_STAKING_PROTOCOLS,
  ...BNB_INFRASTRUCTURE_PROTOCOLS,
};

const CHAIN_PROTOCOL_REGISTRIES: Partial<
  Record<SupportedChain, Readonly<Record<string, ChainProtocol>>>
> = {
  solana: SOLANA_PROTOCOLS,
  ethereum: ETHEREUM_PROTOCOLS,
  bnb: BNB_PROTOCOLS,
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
