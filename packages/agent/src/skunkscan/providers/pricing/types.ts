import { ChainIdentifier } from "../../types";

export type TokenPrice = {
  tokenId: string;
  priceUsd: number | null;
  // Freeform per-provider label (e.g. "jupiter", "moralis", "coingecko"),
  // plus the universal fallback statuses every provider can use when it
  // has no price to report.
  source: string;
};

export interface TokenPriceProvider {
  readonly chainId: ChainIdentifier;
  readonly providerName: string;
  getTokenPrices(tokenIds: string[]): Promise<Record<string, TokenPrice>>;
}

export interface TokenPriceProviderRegistry {
  register(provider: TokenPriceProvider): void;
  unregister(chainId: ChainIdentifier): void;
  get(chainId: ChainIdentifier): TokenPriceProvider | undefined;
  has(chainId: ChainIdentifier): boolean;
  list(): TokenPriceProvider[];
}
