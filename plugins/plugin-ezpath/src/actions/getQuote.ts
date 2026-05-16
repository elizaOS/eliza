import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  ModelClass,
  generateObject,
  composeContext,
  elizaLogger,
} from "@elizaos/core";
import { z } from "zod";
import { getQuote, type Tier } from "../client.js";

// ─── Parameter extraction schema ─────────────────────────────────────────────

const QuoteParamsSchema = z.object({
  sellToken:          z.string().describe("ERC-20 contract address of the token to sell on Base mainnet"),
  buyToken:           z.string().describe("ERC-20 contract address of the token to buy on Base mainnet"),
  sellAmount:         z.string().describe("Amount to sell in the token's smallest unit (base decimals)"),
  slippagePercentage: z.number().optional().describe("Max acceptable slippage as decimal, e.g. 0.01 = 1%"),
  tier:               z.enum(["basic", "resilient", "institutional"]).default("basic")
                        .describe("Execution tier — basic ($0.03), resilient ($0.10), institutional ($0.50)"),
});

const extractionTemplate = `
Extract DEX swap quote parameters from the conversation below.

Known Base mainnet token addresses (use these when the user names a token):
- USDC:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- WETH:  0x4200000000000000000000000000000000000006
- cbETH: 0x2Ae3F1Ec7F1F5012CFEab0185Bfc7aa3cf0DEC22
- WBTC:  0x0555E30da8f98308EdB960aa94C0Db47230d2B9C
- DAI:   0x50c5725949A6F0c72E6C4a641f24049A917DB0Cb
- EURC:  0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42

Recent messages:
{{recentMessages}}

Respond only with valid JSON matching the schema.`;

// ─── Trigger keywords ─────────────────────────────────────────────────────────

const QUOTE_KEYWORDS = [
  "quote", "price", "swap", "trade", "exchange", "convert",
  "how much", "rate", "sell", "buy", "weth", "usdc",
];

function looksLikeQuoteRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return QUOTE_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── Action definition ────────────────────────────────────────────────────────

export const getQuoteAction: Action = {
  name: "GET_SWAP_QUOTE",
  similes: [
    "SWAP_QUOTE", "DEX_PRICE", "TOKEN_PRICE", "PRICE_QUOTE",
    "GET_PRICE", "CHECK_PRICE", "QUOTE_SWAP",
  ],
  description:
    "Fetches a normalized DEX swap price quote for any Base token pair via EZ-Path. " +
    "Automatically negotiates X402 USDC payment and returns the best available route. " +
    "Use when the user asks for a token price, swap rate, or DEX quote on Base.",

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text ?? "").trim();
    return text.length > 0 && looksLikeQuoteRequest(text);
  },

  handler: async (
    runtime:  IAgentRuntime,
    message:  Memory,
    state?:   State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<boolean> => {
    elizaLogger.info("[ezpath] GET_SWAP_QUOTE triggered");

    // ── Read config from agent runtime settings
    const rawKey = runtime.getSetting("EZPATH_WALLET_PRIVATE_KEY");
    if (!rawKey) {
      await callback?.({
        text: "EZ-Path is not configured. Set EZPATH_WALLET_PRIVATE_KEY in your agent settings.",
      });
      return false;
    }
    const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
    const tier = (runtime.getSetting("EZPATH_TIER") ?? "basic") as Tier;

    // ── Extract structured params from the conversation
    const context = composeContext({ state: state ?? ({} as State), template: extractionTemplate });
    let params: z.infer<typeof QuoteParamsSchema>;
    try {
      const result = await generateObject({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
        schema: QuoteParamsSchema,
      });
      params = result.object as z.infer<typeof QuoteParamsSchema>;
    } catch (err) {
      elizaLogger.error("[ezpath] param extraction failed", err);
      await callback?.({ text: "I couldn't parse the token pair from your message. Please include contract addresses or token symbols (USDC, WETH, etc.) and a sell amount." });
      return false;
    }

    if (!params.sellToken || !params.buyToken || !params.sellAmount) {
      await callback?.({ text: "Please specify a sell token, buy token, and sell amount." });
      return false;
    }

    // ── Fetch quote via X402 auto-negotiation
    try {
      elizaLogger.info("[ezpath] fetching quote", { ...params, tier: params.tier });
      const quote = await getQuote({ ...params, tier: params.tier ?? tier, privateKey });

      const meta      = quote.routing_metadata;
      const raceInfo  = meta.race_comparison
        ? `\n  Lane 1 (aggregator): ${meta.race_comparison.lane_1_aggregator_out}\n  Lane 2 (Aerodrome):  ${meta.race_comparison.lane_2_aerodrome_out}`
        : "";
      const settleLine = quote.settlement_tx
        ? `\n  Settlement tx: ${quote.settlement_tx}`
        : "";

      const responseText = [
        `**EZ-Path Quote** · tier: \`${quote.tier}\` · engine: \`${meta.winner}\``,
        ``,
        `Price:      **${quote.price}** ${quote.buyToken.slice(0, 8)}… per ${quote.sellToken.slice(0, 8)}…`,
        `Buy amount: \`${quote.buyAmount}\` (base decimals)`,
        `Sources:    ${quote.sources.map(s => `${s.name} (${(parseFloat(s.proportion) * 100).toFixed(0)}%)`).join(", ")}`,
        `Mode:       \`${meta.execution_mode}\`${raceInfo}`,
        settleLine,
      ].filter(Boolean).join("\n");

      await callback?.({ text: responseText, content: quote });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      elizaLogger.error("[ezpath] quote fetch failed", msg);
      await callback?.({ text: `EZ-Path quote failed: ${msg}` });
      return false;
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "What's the current price to swap 1 USDC for WETH on Base?" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "**EZ-Path Quote** · tier: `basic` · engine: `0x`\n\nPrice: **0.000449** WETH per USDC\nBuy amount: `449260131426107`\nSources: PancakeSwap_Infinity_CL (100%)\nMode: `direct`",
          action: "GET_SWAP_QUOTE",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: { text: "Get me the best route for selling 1000000 USDC atoms for WETH, resilient tier" },
      },
      {
        user: "{{agent}}",
        content: {
          text: "**EZ-Path Quote** · tier: `resilient` · engine: `aerodrome`\n\nPrice: **0.000451** WETH per USDC\nMode: `concurrent_race`",
          action: "GET_SWAP_QUOTE",
        },
      },
    ],
  ],
};
