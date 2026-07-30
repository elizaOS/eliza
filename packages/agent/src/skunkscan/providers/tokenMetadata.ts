import { SupportedChain } from "../types";

export type TokenMetadata = {
  tokenId: string;
  symbol: string | null;
  name: string | null;
  logoUrl: string | null;
  source: "static_registry" | "unknown";
};

const STATIC_SOLANA_TOKEN_METADATA: Readonly<Record<string, TokenMetadata>> = {
  So11111111111111111111111111111111111111112: {
    tokenId: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    logoUrl: null,
    source: "static_registry",
  },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    tokenId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    logoUrl: null,
    source: "static_registry",
  },
  Es9vMFrzaCERmJfrF4H2FYD4FkHfgu4QdHAcjgAb7Yvp: {
    tokenId: "Es9vMFrzaCERmJfrF4H2FYD4FkHfgu4QdHAcjgAb7Yvp",
    symbol: "USDT",
    name: "Tether USD",
    logoUrl: null,
    source: "static_registry",
  },
};

const CHAIN_TOKEN_METADATA_REGISTRIES: Partial<
  Record<SupportedChain, Readonly<Record<string, TokenMetadata>>>
> = {
  solana: STATIC_SOLANA_TOKEN_METADATA,
};

export function getTokenMetadata(
  chain: SupportedChain,
  tokenId: string | null | undefined,
): TokenMetadata | null {
  if (!tokenId) {
    return null;
  }

  const registry = CHAIN_TOKEN_METADATA_REGISTRIES[chain];

  return (
    registry?.[tokenId] ?? {
      tokenId,
      symbol: null,
      name: null,
      logoUrl: null,
      source: "unknown",
    }
  );
}
