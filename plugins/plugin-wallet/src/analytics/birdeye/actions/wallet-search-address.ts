// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type Action,
  type ActionExample,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { BirdeyeProvider } from "../birdeye";
import { searchBirdeyeTokens } from "../search-category";
import type { WalletPortfolioResponse } from "../types/api/wallet";
import type { BaseAddress } from "../types/shared";
import { extractAddresses } from "../utils";

export type BirdeyeLookupKind =
  | "wallet-address"
  | "token-address"
  | "token-symbol";

function readKind(
  options: Record<string, unknown> | undefined,
  text: string,
): BirdeyeLookupKind {
  const raw = String(options?.kind ?? "").toLowerCase();
  if (
    raw === "wallet-address" ||
    raw === "token-address" ||
    raw === "token-symbol"
  ) {
    return raw;
  }
  // Auto-infer: explicit address → wallet-address (preserves legacy behavior),
  // otherwise token-symbol search via the token search category.
  return extractAddresses(text).length > 0 ? "wallet-address" : "token-symbol";
}

function selectedContextMatches(
  state: State | undefined,
  contexts: readonly string[],
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

function hasBirdeyeIntent(message: Memory, state?: State): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  const keywords = [
    "birdeye",
    "wallet",
    "token",
    "lookup",
    "search",
    "portfolio",
    "address",
    "crypto",
    "symbol",
    "cartera",
    "token",
    "buscar",
    "adresse",
    "portefeuille",
    "rechercher",
    "wallet",
    "adresse",
    "suchen",
    "ウォレット",
    "トークン",
    "検索",
    "钱包",
    "代币",
    "搜索",
    "지갑",
    "토큰",
    "검색",
  ];
  return keywords.some((keyword) => text.includes(keyword));
}

export const walletSearchAddressAction = {
  name: "BIRDEYE_LOOKUP",
  similes: [
    "BIRDEYE_WALLET_SEARCH_ADDRESS",
    "SEARCH_WALLET_ADDRESS",
    "LOOKUP_WALLET_ADDRESS",
    "CHECK_WALLET_ADDRESS",
    "WALLET_ADDRESS_INFO",
    "WALLET_ADDRESS_LOOKUP",
    "WALLET_INFO",
    "WALLET_OVERVIEW",
    "WALLET_LOOKUP",
    "BIRDEYE_TOKEN_SEARCH",
    "TOKEN_LOOKUP",
    "TOKEN_SEARCH",
  ],
  description:
    "Look up Birdeye intel for a wallet, token contract, or token symbol via { kind: 'wallet-address' | 'token-address' | 'token-symbol', query }.",
  descriptionCompressed:
    "Birdeye lookup: token-symbol, token-address, wallet-address.",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "kind",
      description: "Lookup mode.",
      required: false,
      schema: {
        type: "string",
        enum: ["wallet-address", "token-address", "token-symbol"],
      },
    },
    {
      name: "query",
      description: "Wallet address, token address, or token symbol to look up.",
      required: true,
      schema: { type: "string" },
    },
  ],
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    try {
      const text = String(message.content?.text ?? "");
      const queryParam =
        typeof options?.query === "string" ? options.query : "";
      const query = queryParam.trim() || text;
      const kind = readKind(options, query);

      if (kind === "token-symbol" || kind === "token-address") {
        const result = await searchBirdeyeTokens(runtime, {
          query,
          mode: kind === "token-address" ? "address" : "symbol",
        });
        callback?.({ text: result.text });
        return {
          success: true,
          text: result.text,
          data: result,
        };
      }

      const provider = new BirdeyeProvider(runtime);

      // get all wallet addresses from the message (legacy wallet-address path)
      const addresses = extractAddresses(query);

      elizaLogger.info(
        `Searching Birdeye provider for ${addresses.length} addresses`,
      );

      // for each symbol, do a search in Birdeye. This will return a list of token results that may be amatch to the token symbol.
      const results: WalletPortfolioResponse[] = await Promise.all(
        addresses.map(async ({ address, chain: addressChain }) => {
          // address detection can't distinguish between evm chains, so we currently only do address search on ETH for EVM addresses. Future support will be added for other chains if the user requests it.
          const chain = addressChain === "evm" ? "ethereum" : addressChain;
          return provider.fetchWalletPortfolio(
            {
              wallet: address,
            },
            {
              headers: {
                chain: chain,
              },
            },
          );
        }),
      );

      runtime.logger?.debug(
        `Wallet search results: ${JSON.stringify(results)}`,
      );

      const completeResults = `I performed a search for the wallet addresses you requested and found the following results:\n\n${results
        .map(
          (result, i) =>
            `${formatWalletReport(addresses[i], results.length, i, result)}`,
        )
        .join("\n\n")}`;

      callback?.({ text: completeResults });
      return {
        success: true,
        text: completeResults,
        data: {
          kind,
          resultCount: results.length,
          results,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      runtime.logger?.error("Error in searchTokens handler:", errorMessage);
      callback?.({ text: `Error: ${errorMessage}` });
      return {
        success: false,
        text: `Error: ${errorMessage}`,
        error: errorMessage,
      };
    }
  },
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    if (selectedContextMatches(state, ["finance", "crypto", "wallet"])) {
      return true;
    }
    const text = message.content?.text ?? "";
    if (!text || typeof text !== "string") return false;
    if (extractAddresses(text).length > 0) return true;
    // Allow token-symbol lookups when text contains $TICKER or "lookup/search/birdeye"
    if (/\$[A-Z]{2,10}\b/.test(text)) return true;
    return (
      hasBirdeyeIntent(message, state) &&
      /\b(birdeye|lookup|search\s+(?:token|wallet|symbol|address))\b/i.test(
        text,
      )
    );
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Search wallet 0x1234567890abcdef1234567890abcdef12345678",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Searching wallet 0x1234567890abcdef1234567890abcdef12345678",
          actions: ["BIRDEYE_WALLET_SEARCH_ADDRESS"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Look up wallet address HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Looking up wallet address HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
          actions: ["WALLET_ADDRESS_LOOKUP"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Check this address: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Checking this address: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          actions: ["CHECK_WALLET_ADDRESS"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Get wallet info for 5yBYpGQRHPz4i5FkVnP9h9VTJBMnwgHRe5L5gw2bwp9q",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Getting wallet info for 5yBYpGQRHPz4i5FkVnP9h9VTJBMnwgHRe5L5gw2bwp9q",
          actions: ["WALLET_INFO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me portfolio for 0x3cD751E6b0078Be393132286c442345e5DC49699",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Show me portfolio for 0x3cD751E6b0078Be393132286c442345e5DC49699",
          actions: ["WALLET_OVERVIEW"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

// take all the details of the results and present to the user
const formatWalletReport = (
  address: BaseAddress,
  totalResults: number,
  index: number,
  result: WalletPortfolioResponse,
) => {
  const tokens = result.data.items.slice(0, 10) || [];
  const totalValue = tokens.reduce(
    (sum, token) => sum + (token.valueUsd || 0),
    0,
  );

  let header = `Wallet Result ${totalResults > 1 ? `#${index + 1}` : ""}\n`;
  header += `👛 Address ${address.address}*\n`;
  header += `💰 Total Value: $${totalValue.toLocaleString()}\n`;
  header += "🔖 Top Holdings:";
  const tokenList = tokens
    .map(
      (token) =>
        `• $${token?.symbol?.toUpperCase()}: $${token.valueUsd?.toLocaleString()} (${token.uiAmount?.toFixed(4)} tokens)`,
    )
    .join("\n");

  return `${header}\n${tokenList}`;
};
