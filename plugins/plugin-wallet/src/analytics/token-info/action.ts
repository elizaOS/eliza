import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  parseTokenInfoParams,
  selectedContextMatches,
} from "./params";
import {
  TOKEN_INFO_SERVICE_TYPE,
  type TokenInfoService,
} from "./service";
import { TOKEN_INFO_SUBACTIONS } from "./types";

const TOKEN_INFO_CONTEXTS = ["finance", "crypto", "wallet"] as const;
const TOKEN_INFO_KEYWORDS = [
  "token",
  "coin",
  "crypto",
  "dexscreener",
  "birdeye",
  "coingecko",
  "price",
  "pair",
  "pairs",
  "market cap",
  "liquidity",
  "trending",
  "wallet",
  "portfolio",
  "boosted",
  "profile",
] as const;

function hasTokenInfoIntent(message: Memory, state?: State): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return TOKEN_INFO_KEYWORDS.some((keyword) => text.includes(keyword));
}

function unavailable(
  callback: HandlerCallback | undefined,
  text: string,
  data: Record<string, any>,
): ActionResult {
  callback?.({ text, actions: ["TOKEN_INFO"], data });
  return {
    success: false,
    text,
    error: String(data.error ?? "TOKEN_INFO_UNAVAILABLE"),
    data,
  };
}

export const tokenInfoAction: Action = {
  name: "TOKEN_INFO",
  contexts: [...TOKEN_INFO_CONTEXTS],
  contextGate: { anyOf: [...TOKEN_INFO_CONTEXTS] },
  roleGate: { minRole: "USER" },
  similes: [
    "DEXSCREENER_SEARCH",
    "DEXSCREENER_TOKEN_INFO",
    "DEXSCREENER_TRENDING",
    "DEXSCREENER_NEW_PAIRS",
    "DEXSCREENER_CHAIN_PAIRS",
    "DEXSCREENER_BOOSTED_TOKENS",
    "DEXSCREENER_TOKEN_PROFILES",
    "BIRDEYE_LOOKUP",
    "BIRDEYE_TOKEN_SEARCH",
    "TOKEN_SEARCH",
    "TOKEN_LOOKUP",
    "TOKEN_PRICE",
    "COINGECKO",
  ],
  description:
    "Fetch crypto token and market information from registered providers. target selects provider (dexscreener, birdeye, coingecko). subaction selects search, token, trending, new-pairs, chain-pairs, boosted, profiles, or wallet.",
  descriptionCompressed:
    "Crypto token info provider registry: target dexscreener|birdeye|coingecko; subaction search|token|trending|new-pairs|chain-pairs|boosted|profiles|wallet.",
  parameters: [
    {
      name: "target",
      description:
        "Provider to use. Omit to use the default provider for the subaction.",
      required: false,
      schema: { type: "string", enum: ["dexscreener", "birdeye", "coingecko"] },
      examples: ["dexscreener", "birdeye", "coingecko"],
    },
    {
      name: "subaction",
      description: "Token information operation.",
      required: true,
      schema: { type: "string", enum: [...TOKEN_INFO_SUBACTIONS] },
      examples: ["search", "token", "trending", "wallet"],
    },
    {
      name: "query",
      description: "Search query, coin id, token symbol, token address, or wallet address.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "address",
      description: "Token or wallet address.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "tokenAddress",
      description: "Token contract address.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "chain",
      description:
        "Chain/network for provider operations that need one, such as chain-pairs or CoinGecko contract lookup.",
      required: false,
      schema: { type: "string" },
      examples: ["ethereum", "solana", "base"],
    },
    {
      name: "timeframe",
      description: "Trending window when supported.",
      required: false,
      schema: { type: "string", enum: ["1h", "6h", "24h"], default: "24h" },
    },
    {
      name: "limit",
      description: "Maximum result count.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 100, default: 10 },
    },
    {
      name: "sortBy",
      description: "Pair ranking metric for chain-pairs.",
      required: false,
      schema: {
        type: "string",
        enum: ["volume", "liquidity", "priceChange", "txns"],
      },
    },
    {
      name: "top",
      description: "For boosted tokens, return top boosted rather than latest.",
      required: false,
      schema: { type: "boolean", default: false },
    },
    {
      name: "id",
      description: "CoinGecko coin id.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (_runtime, message, state) =>
    selectedContextMatches(state, TOKEN_INFO_CONTEXTS) ||
    hasTokenInfoIntent(message, state),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService(
      TOKEN_INFO_SERVICE_TYPE,
    ) as TokenInfoService | null;
    if (!service || typeof service.route !== "function") {
      return unavailable(callback, "Token info service is not available.", {
        actionName: "TOKEN_INFO",
        error: "SERVICE_UNAVAILABLE",
      });
    }

    const params = parseTokenInfoParams(message, state, options);
    const routed = await service.route({
      runtime,
      message,
      state,
      options,
      params,
      callback,
    });

    if (routed.ok) {
      const result = routed.result;
      return {
        ...result,
        data: {
          ...(result.data ?? {}),
          actionName: "TOKEN_INFO",
          target: routed.provider.name,
          supportedProviders: service.listProviders(),
        },
      };
    }

    return unavailable(callback, routed.detail, {
      actionName: "TOKEN_INFO",
      error: routed.error,
      detail: routed.detail,
      providers: routed.providers,
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Search for PEPE on DexScreener" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Searching DexScreener.",
          action: "TOKEN_INFO",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Look up bitcoin on CoinGecko" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Looking up Bitcoin on CoinGecko.",
          action: "TOKEN_INFO",
        },
      },
    ],
  ],
};
