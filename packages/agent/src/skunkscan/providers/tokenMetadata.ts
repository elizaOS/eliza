export type TokenMetadata = {
  mint: string;
  symbol: string | null;
  name: string | null;
  logoUrl: string | null;
  source: "static_registry" | "unknown";
};

const STATIC_SOLANA_TOKEN_METADATA: Record<string, TokenMetadata> = {
  So11111111111111111111111111111111111111112: {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    logoUrl: null,
    source: "static_registry",
  },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    logoUrl: null,
    source: "static_registry",
  },
  Es9vMFrzaCERmJfrF4H2FYD4FkHfgu4QdHAcjgAb7Yvp: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4FkHfgu4QdHAcjgAb7Yvp",
    symbol: "USDT",
    name: "Tether USD",
    logoUrl: null,
    source: "static_registry",
  },
};

export function getSolanaTokenMetadata(
  mint: string | null | undefined,
): TokenMetadata | null {
  if (!mint) {
    return null;
  }

  return (
    STATIC_SOLANA_TOKEN_METADATA[mint] ?? {
      mint,
      symbol: null,
      name: null,
      logoUrl: null,
      source: "unknown",
    }
  );
}
