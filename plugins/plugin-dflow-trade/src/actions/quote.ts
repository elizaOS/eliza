import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { DflowClient, formatQuote } from "../client/dflow-client.js";
import { readDflowTradeConfig, toAtomicAmount } from "../config.js";
import { parseTradeIntent } from "../parse-trade.js";
import { loadKeypair } from "../services/wallet.js";

export const dflowQuoteAction: Action = {
  name: "DFLOW_QUOTE",
  similes: ["SOLANA_QUOTE", "SWAP_QUOTE", "PRICE_SWAP", "DFLOW_PRICE"],
  description:
    "Get a DFlow Solana spot quote (GET /order). Example: quote 0.01 SOL to USDC. Uses DFLOW_API_KEY + quote-api.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /quote|how much|price for|swap\s+\d|trade\s+\d/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
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
      if (callback) await callback({ text: body, actions: ["DFLOW_QUOTE"] });
      return { success: false, text: body };
    }

    if (!parsed.atomicAmount) {
      if (parsed.input.decimals == null) {
        const body = `Mint ${parsed.input.mint} needs decimals — use a known symbol (SOL, USDC) or pass atomic amount.`;
        if (callback) await callback({ text: body, actions: ["DFLOW_QUOTE"] });
        return { success: false, text: body };
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
      if (callback) await callback({ text: body, actions: ["DFLOW_QUOTE"] });
      return {
        success: true,
        text: body,
        data: { order, parsed, tradeApiUrl: cfg.tradeApiUrl },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const body = `DFlow quote failed: ${msg}`;
      if (callback) await callback({ text: body, actions: ["DFLOW_QUOTE"] });
      return { success: false, text: body, error: err as Error };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Quote 0.01 SOL to USDC on DFlow" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Fetching DFlow order quote…",
          actions: ["DFLOW_QUOTE"],
        },
      },
    ],
  ],
};
