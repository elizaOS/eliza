import { TokenPrice, TokenPriceProvider } from "./types";
import { getEthereumTokenPrices, MoralisEvmChain } from "../../moralis";
import { SupportedChain } from "../../types";

// One TokenPriceProvider instance per EVM chain (the registry keys by a
// single chainId per provider - see providers/pricing/registry.ts), all
// backed by the same Moralis batch endpoint, just pointed at a different
// `chain` query param. Token IDs here are already contract addresses
// (native assets are priced under their wrapped-token address - see
// priceProvider.ts's WRAPPED_NATIVE_ASSET_ID), so no per-chain ID mapping
// is needed beyond which Moralis `chain` string to send.
export class EvmTokenPriceProvider implements TokenPriceProvider {
  readonly chainId: SupportedChain;
  readonly providerName = "Moralis";
  private readonly moralisChain: MoralisEvmChain;

  constructor(chainId: SupportedChain, moralisChain: MoralisEvmChain) {
    this.chainId = chainId;
    this.moralisChain = moralisChain;
  }

  async getTokenPrices(
    tokenIds: string[],
  ): Promise<Record<string, TokenPrice>> {
    const uniqueTokenIds = Array.from(
      new Set(tokenIds.map((tokenId) => tokenId.trim()).filter(Boolean)),
    );

    if (uniqueTokenIds.length === 0) {
      return {};
    }

    let pricesByAddress: Record<string, number | null>;

    try {
      pricesByAddress = await getEthereumTokenPrices(
        uniqueTokenIds,
        this.moralisChain,
      );
    } catch {
      pricesByAddress = {};
    }

    // getEthereumTokenPrices lowercases every address it returns keys for
    // (see moralis.ts) - matching back to the original tokenId casing here
    // rather than lowercasing tokenId itself, since portfolio.ts looks
    // prices up by the exact tokenId string it already holds.
    return uniqueTokenIds.reduce<Record<string, TokenPrice>>(
      (prices, tokenId) => {
        const priceUsd = pricesByAddress[tokenId.toLowerCase()] ?? null;

        prices[tokenId] = {
          tokenId,
          priceUsd,
          source: priceUsd !== null ? "moralis" : "unknown",
        };

        return prices;
      },
      {},
    );
  }
}

export const ethereumTokenPriceProvider = new EvmTokenPriceProvider(
  "ethereum",
  "eth",
);

export const bnbTokenPriceProvider = new EvmTokenPriceProvider("bnb", "bsc");

export const baseTokenPriceProvider = new EvmTokenPriceProvider(
  "base",
  "base",
);
