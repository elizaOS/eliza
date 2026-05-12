/**
 * Action: hyperd.dex.quote
 *
 * Calls GET /api/dex/quote to find the best swap route across Paraswap + 0x
 * for a (from, to, amount) triple. Cost: $0.02 in USDC on Base.
 *
 * Activated when the user asks for a swap quote, asks "what's the best price"
 * for an exchange, or describes a swap of one token for another.
 */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { HyperdClient, HyperdRequestError } from "../client.js";
import { resolveConfig } from "../config.js";
import type { DexQuoteResponse } from "../types.js";

const CHAIN_RE = /\b(base|ethereum|eth|mainnet|polygon|arbitrum|optimism|avalanche|bnb)\b/i;
// Match "100 USDC for/to WETH", "swap 0.5 ETH to USDT", "1000 USDC -> WETH"
const SWAP_RE =
  /([\d]+(?:\.[\d]+)?)\s*([A-Z]{2,10})\s+(?:to|for|->|=>|→|into|in)\s+([A-Z]{2,10})/i;

interface SwapParams {
  amount: string;
  from: string;
  to: string;
  chain: string;
}

function extractSwap(text: string | undefined): SwapParams | null {
  if (!text) return null;
  const m = text.match(SWAP_RE);
  if (!m) return null;
  const chainMatch = text.match(CHAIN_RE);
  let chain = "base";
  if (chainMatch) {
    const v = chainMatch[0].toLowerCase();
    chain = v === "eth" || v === "mainnet" ? "ethereum" : v;
  }
  return {
    amount: m[1]!,
    from: m[2]!.toUpperCase(),
    to: m[3]!.toUpperCase(),
    chain,
  };
}

export const dexQuoteAction: Action = {
  name: "HYPERD_DEX_QUOTE",
  description:
    "Get the best swap route for a token pair, aggregated across Paraswap + 0x. Returns the highest output amount, gas estimate, slippage, and per-source quote breakdown. Use when the user asks for a swap quote, asks 'what's the best price', or describes exchanging one token for another (e.g. '100 USDC to WETH').",
  similes: [
    "DEX_QUOTE",
    "SWAP_QUOTE",
    "BEST_PRICE",
    "GET_SWAP_RATE",
    "TOKEN_EXCHANGE_RATE",
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return extractSwap(message?.content?.text) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ) => {
    const swap = extractSwap(message?.content?.text);
    if (!swap) {
      await callback?.({
        text:
          "I couldn't parse a swap from the message. Try something like '100 USDC to WETH' or '0.5 ETH for USDT'.",
        source: "hyperd",
      });
      return { success: false };
    }

    let client: HyperdClient;
    try {
      client = new HyperdClient(resolveConfig(runtime));
    } catch (err) {
      await callback?.({
        text: `hyperD plugin misconfigured: ${err instanceof Error ? err.message : String(err)}`,
        source: "hyperd",
      });
      return { success: false };
    }

    try {
      const res = await client.get<DexQuoteResponse>("/api/dex/quote", {
        from: swap.from,
        to: swap.to,
        amount: swap.amount,
        chain: swap.chain,
      });
      const lines: string[] = [];
      lines.push(`DEX quote — ${swap.amount} ${swap.from} → ${swap.to} on ${swap.chain}:`);
      lines.push(`• Best: ${res.best.amount_out} ${swap.to} via ${res.best.source}`);
      lines.push(`• Slippage: ${res.best.slippage_pct.toFixed(2)}%`);
      lines.push(`• Gas estimate: ${res.best.gas_estimate}`);
      if (res.alternatives.length > 0) {
        lines.push("• Alternatives:");
        for (const a of res.alternatives) {
          lines.push(`  · ${a.source}: ${a.amount_out} ${swap.to}`);
        }
      }
      await callback?.({
        text: lines.join("\n"),
        source: "hyperd",
        action: "HYPERD_DEX_QUOTE",
      });
      return { success: true };
    } catch (err) {
      const errText = err instanceof HyperdRequestError
        ? `hyperD returned ${err.status}: ${err.message}`
        : `hyperD dex-quote call failed: ${err instanceof Error ? err.message : String(err)}`;
      await callback?.({ text: errText, source: "hyperd" });
      return { success: false };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "What's the best price for 100 USDC to WETH?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Aggregating quotes across Paraswap and 0x...",
          action: "HYPERD_DEX_QUOTE",
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Swap 0.5 ETH for USDT on arbitrum" } },
      {
        name: "{{agent}}",
        content: { text: "Getting the best swap route...", action: "HYPERD_DEX_QUOTE" },
      },
    ],
  ],
};
