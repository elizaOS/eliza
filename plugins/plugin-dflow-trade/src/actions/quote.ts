import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { actionFailure, actionSuccess } from "../action-result.js";
import { DflowClient, formatQuote } from "../client/dflow-client.js";
import { readDflowTradeConfig, toAtomicAmount } from "../config.js";
import { parseTradeIntent } from "../parse-trade.js";
import { loadKeypair } from "../services/wallet.js";

const ACTION = "DFLOW_QUOTE";

export const dflowQuoteAction: Action = {
  name: ACTION,
  similes: ["SOLANA_QUOTE", "SWAP_QUOTE", "PRICE_SWAP", "DFLOW_PRICE"],
  description:
    "Get a DFlow Solana spot quote (GET /order). Chain before DFLOW_SWAP — result is stored in actionResults for the next step. Example: quote 0.01 SOL to USDC.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /quote|how much|price for|swap\s+\d|trade\s+\d/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const getSetting = (k: string) =>
      runtime.getSetting?.(k) as string | undefined;
    const cfg = readDflowTradeConfig(getSetting);
    const text = message.content?.text || "";
    const parsed = parseTradeIntent(text, cfg);

    if (!parsed) {
      const body =
        "Could not parse trade. Try: “quote 0.01 SOL to USDC” or “swap 1 USDC to SOL”.";
      if (callback) await callback({ text: body }, ACTION);
      return actionFailure(ACTION, body);
    }

    if (!parsed.atomicAmount) {
      if (parsed.input.decimals == null) {
        const body = `Mint ${parsed.input.mint} needs decimals — use a known symbol (SOL, USDC) or pass atomic amount.`;
        if (callback) await callback({ text: body }, ACTION);
        return actionFailure(ACTION, body);
      }
      parsed.atomicAmount = toAtomicAmount(
        parsed.humanAmount,
        parsed.input.decimals,
      );
    }

    let userPublicKey: string | undefined;
    if (cfg.privateKeyBase58) {
      try {
        const kp = await loadKeypair(cfg.privateKeyBase58);
        userPublicKey = kp.publicKey;
      } catch {
        /* quote-only without wallet */
      }
    }

    const client = new DflowClient(cfg);
    try {
      const order = await client.getOrder({
        inputMint: parsed.input.mint,
        outputMint: parsed.output.mint,
        amount: parsed.atomicAmount,
        userPublicKey,
      });
      const body = formatQuote(order, {
        inSymbol: parsed.input.symbol,
        outSymbol: parsed.output.symbol,
        humanIn: parsed.humanAmount,
      });
      if (callback) await callback({ text: body }, ACTION);
      // Chain payload: DFLOW_SWAP can reuse parsed + order without re-asking the user
      return actionSuccess(
        ACTION,
        body,
        {
          order,
          parsed,
          tradeApiUrl: cfg.tradeApiUrl,
          inputMint: parsed.input.mint,
          outputMint: parsed.output.mint,
          atomicAmount: parsed.atomicAmount,
        },
        {
          values: {
            lastDflowQuoteOut: order.outAmount ?? null,
            lastDflowPair: `${parsed.input.symbol}->${parsed.output.symbol}`,
          },
          // Quote alone is complete for a quote-only turn; multi-step plans continue
          turnComplete: true,
          verifiedUserFacing: true,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const body = `DFlow quote failed: ${msg}`;
      if (callback) await callback({ text: body }, ACTION);
      return actionFailure(ACTION, body, err);
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Quote 0.01 SOL to USDC then prepare a preview swap" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll quote on DFlow, then preview the swap using that quote.",
          actions: ["DFLOW_QUOTE", "DFLOW_SWAP"],
        },
      },
    ],
  ],
};
