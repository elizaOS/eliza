import { TokenPrice, TokenPriceProvider } from "./types";
import { getBitcoinMarketPriceUsd } from "../../blockchair";

// Bitcoin has no native fungible-token standard (see chains/bitcoin.ts) -
// there is exactly one priceable asset, the native coin itself. The ID
// portfolio.ts looks it up under is priceProvider.ts's
// BITCOIN_NATIVE_ASSET_PRICE_ID (must match chains/bitcoin.ts's
// BITCOIN_NATIVE_ASSET.assetId exactly) - this provider doesn't need to
// know that ID itself, since it answers whatever ID(s) it's asked about
// with the same BTC/USD rate (see the comment below).
export class BitcoinTokenPriceProvider implements TokenPriceProvider {
  readonly chainId = "bitcoin";
  readonly providerName = "Blockchair";

  async getTokenPrices(
    tokenIds: string[],
  ): Promise<Record<string, TokenPrice>> {
    const uniqueTokenIds = Array.from(
      new Set(tokenIds.map((tokenId) => tokenId.trim()).filter(Boolean)),
    );

    if (uniqueTokenIds.length === 0) {
      return {};
    }

    let priceUsd: number | null;

    try {
      priceUsd = await getBitcoinMarketPriceUsd();
    } catch {
      priceUsd = null;
    }

    // The same BTC/USD rate applies to every requested ID, since the only
    // ID that will ever legitimately be requested here is the native asset
    // price ID (Bitcoin has no tokens to price) - this doesn't special-case
    // that ID rather than just answering whatever was asked, so an
    // unexpected extra ID degrades to "same price" rather than "silently
    // missing" if portfolio.ts's calling pattern ever changes.
    return uniqueTokenIds.reduce<Record<string, TokenPrice>>(
      (prices, tokenId) => {
        prices[tokenId] = {
          tokenId,
          priceUsd,
          source: priceUsd !== null ? "blockchair" : "unknown",
        };

        return prices;
      },
      {},
    );
  }
}

export const bitcoinTokenPriceProvider = new BitcoinTokenPriceProvider();
