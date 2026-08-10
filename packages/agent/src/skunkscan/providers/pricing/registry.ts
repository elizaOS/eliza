import { ChainIdentifier } from "../../types";

import {
  TokenPriceProvider,
  TokenPriceProviderRegistry,
} from "./types";

import { solanaTokenPriceProvider } from "./solana";
import { bitcoinTokenPriceProvider } from "./bitcoin";

export class DefaultTokenPriceProviderRegistry
  implements TokenPriceProviderRegistry
{
  private readonly providers = new Map<
    ChainIdentifier,
    TokenPriceProvider
  >();

  register(provider: TokenPriceProvider): void {
    this.providers.set(
      provider.chainId,
      provider,
    );
  }

  unregister(chainId: ChainIdentifier): void {
    this.providers.delete(chainId);
  }

  get(
    chainId: ChainIdentifier,
  ): TokenPriceProvider | undefined {
    return this.providers.get(chainId);
  }

  has(chainId: ChainIdentifier): boolean {
    return this.providers.has(chainId);
  }

  list(): TokenPriceProvider[] {
    return Array.from(this.providers.values());
  }
}

export const tokenPriceProviderRegistry =
  new DefaultTokenPriceProviderRegistry();

tokenPriceProviderRegistry.register(
  solanaTokenPriceProvider,
);

tokenPriceProviderRegistry.register(
  bitcoinTokenPriceProvider,
);

export function getTokenPriceProvider(
  chainId: ChainIdentifier,
): TokenPriceProvider | undefined {
  return tokenPriceProviderRegistry.get(chainId);
}

export function requireTokenPriceProvider(
  chainId: ChainIdentifier,
): TokenPriceProvider {
  const provider =
    tokenPriceProviderRegistry.get(chainId);

  if (!provider) {
    throw new Error(
      `No token price provider is registered for chain "${chainId}"`,
    );
  }

  return provider;
}

export function listTokenPriceProviders(): TokenPriceProvider[] {
  return tokenPriceProviderRegistry.list();
}
