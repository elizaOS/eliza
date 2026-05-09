import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  createBirdeyeTokenInfoProvider,
  createCoinGeckoTokenInfoProvider,
  createDexScreenerTokenInfoProvider,
} from "./providers";
import type {
  TokenInfoDispatchContext,
  TokenInfoProvider,
  TokenInfoProviderMetadata,
  TokenInfoRouteResult,
  TokenInfoSubaction,
} from "./types";

export const TOKEN_INFO_SERVICE_TYPE = "token-info" as const;

const DEFAULT_PROVIDER_BY_SUBACTION: Record<TokenInfoSubaction, string> = {
  search: "dexscreener",
  token: "dexscreener",
  trending: "dexscreener",
  "new-pairs": "dexscreener",
  "chain-pairs": "dexscreener",
  boosted: "dexscreener",
  profiles: "dexscreener",
  wallet: "birdeye",
};

function normalizeProviderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export class TokenInfoService extends Service {
  static override serviceType = TOKEN_INFO_SERVICE_TYPE;

  override capabilityDescription =
    "Token information provider registry for DexScreener, Birdeye, CoinGecko, and future crypto data sources";

  private readonly providers = new Map<string, TokenInfoProvider>();
  private readonly aliases = new Map<string, string>();

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<TokenInfoService> {
    const service = new TokenInfoService(runtime);
    service.registerProvider(createDexScreenerTokenInfoProvider());
    service.registerProvider(createBirdeyeTokenInfoProvider());
    service.registerProvider(createCoinGeckoTokenInfoProvider());
    return service;
  }

  registerProvider(provider: TokenInfoProvider): void {
    const key = normalizeProviderKey(provider.name);
    this.providers.set(key, provider);
    for (const alias of [provider.name, ...provider.aliases]) {
      this.aliases.set(normalizeProviderKey(alias), key);
    }
  }

  listProviders(): TokenInfoProviderMetadata[] {
    return [...this.providers.values()].map((provider) =>
      this.toMetadata(provider),
    );
  }

  getCapabilities(): {
    readonly providers: readonly TokenInfoProviderMetadata[];
  } {
    return {
      providers: this.listProviders(),
    };
  }

  async route(
    context: TokenInfoDispatchContext,
  ): Promise<TokenInfoRouteResult> {
    const providerResult = this.resolveProvider(
      context.params.target,
      context.params.subaction,
    );
    if (!providerResult.ok) {
      return providerResult;
    }

    try {
      return {
        ok: true,
        provider: this.toMetadata(providerResult.provider),
        result: await providerResult.provider.execute(context),
      };
    } catch (error) {
      return {
        ok: false,
        error: "EXECUTION_FAILED",
        detail: error instanceof Error ? error.message : String(error),
        providers: [this.toMetadata(providerResult.provider)],
      };
    }
  }

  override async stop(): Promise<void> {
    this.providers.clear();
    this.aliases.clear();
  }

  private resolveProvider(
    target: string | undefined,
    subaction: TokenInfoSubaction,
  ):
    | { readonly ok: true; readonly provider: TokenInfoProvider }
    | Extract<TokenInfoRouteResult, { readonly ok: false }> {
    if (target) {
      const key = this.aliases.get(normalizeProviderKey(target));
      const provider = key ? this.providers.get(key) : undefined;
      if (!provider) {
        return {
          ok: false,
          error: "UNSUPPORTED_PROVIDER",
          detail: `Unsupported token info provider "${target}".`,
          providers: this.listProviders(),
        };
      }
      if (!provider.supportedSubactions.includes(subaction)) {
        return {
          ok: false,
          error: "UNSUPPORTED_SUBACTION",
          detail: `${provider.name} does not support ${subaction}.`,
          providers: [this.toMetadata(provider)],
        };
      }
      return { ok: true, provider };
    }

    const preferred = DEFAULT_PROVIDER_BY_SUBACTION[subaction];
    const provider = this.providers.get(preferred);
    if (provider?.supportedSubactions.includes(subaction)) {
      return { ok: true, provider };
    }

    const candidates = [...this.providers.values()].filter((candidate) =>
      candidate.supportedSubactions.includes(subaction),
    );
    if (candidates.length === 1) {
      return { ok: true, provider: candidates[0] };
    }

    return {
      ok: false,
      error: "UNSUPPORTED_SUBACTION",
      detail:
        candidates.length === 0
          ? `No token info provider supports ${subaction}.`
          : `Choose a token info provider for ${subaction}.`,
      providers: candidates.map((candidate) => this.toMetadata(candidate)),
    };
  }

  private toMetadata(provider: TokenInfoProvider): TokenInfoProviderMetadata {
    return {
      name: provider.name,
      aliases: [...provider.aliases],
      supportedSubactions: [...provider.supportedSubactions],
      description: provider.description,
    };
  }
}
