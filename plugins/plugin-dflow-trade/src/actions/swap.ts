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
  actionFailure,
  actionSuccess,
  getPriorActionResult,
} from "../action-result.js";
import { DflowClient, formatQuote } from "../client/dflow-client.js";
import { readDflowTradeConfig, toAtomicAmount } from "../config.js";
import { parseTradeIntent, type ParsedTrade } from "../parse-trade.js";
import { assertLiveReady, loadKeypair } from "../services/wallet.js";

const ACTION = "DFLOW_SWAP";

function tradeFromPriorQuote(
  prior: ActionResult | undefined,
): ParsedTrade | null {
  const data = prior?.data as
    | {
        parsed?: ParsedTrade;
        atomicAmount?: string;
        inputMint?: string;
        outputMint?: string;
      }
    | undefined;
  if (!data?.parsed) return null;
  const p = data.parsed;
  if (data.atomicAmount) p.atomicAmount = data.atomicAmount;
  return p;
}

export const dflowSwapAction: Action = {
  name: ACTION,
  similes: [
    "SOLANA_SWAP",
    "EXECUTE_SWAP",
    "TRADE_SOLANA",
    "DFLOW_TRADE",
    "SWAP_TOKENS",
  ],
  description:
    "Preview or execute a Solana spot swap via DFlow. Prefer chaining after DFLOW_QUOTE (reads actionResults). Default preview; live only with SOLANA_TRADE_LIVE=true and user says execute/live.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /swap|trade|buy|sell|convert|execute\s+swap|dflow|preview/i.test(
      text,
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const getSetting = (k: string) =>
      runtime.getSetting?.(k) as string | undefined;
    const cfg = readDflowTradeConfig(getSetting);
    const text = message.content?.text || "";

    // Multi-step: reuse prior DFLOW_QUOTE when utterance is vague ("preview that")
    const priorQuote = getPriorActionResult("DFLOW_QUOTE", options, state);
    let parsed = parseTradeIntent(text, cfg);
    if (!parsed && priorQuote) {
      parsed = tradeFromPriorQuote(priorQuote);
      if (parsed) {
        // inherit live intent from current message if any
        if (/\b(live|execute)\b/i.test(text)) {
          parsed.live = true;
          parsed.previewOnly = false;
        }
      }
    }

    if (!parsed) {
      const body =
        "Could not parse swap (and no prior DFLOW_QUOTE). Try: “swap 0.01 SOL to USDC” or chain DFLOW_QUOTE then DFLOW_SWAP.";
      if (callback) await callback({ text: body }, ACTION);
      return actionFailure(ACTION, body);
    }

    if (parsed.input.decimals == null && !parsed.atomicAmount) {
      const body = `Unknown decimals for ${parsed.input.symbol}. Use SOL/USDC/USDT or chain after a quote.`;
      if (callback) await callback({ text: body }, ACTION);
      return actionFailure(ACTION, body);
    }
    const atomic =
      parsed.atomicAmount ||
      toAtomicAmount(parsed.humanAmount, parsed.input.decimals!);

    const wantLive = parsed.live && !parsed.previewOnly;

    try {
      let publicKey: string | undefined;
      let signAndSend:
        | ((
            order: import("../client/dflow-client.js").DflowOrderResponse,
            rpc: string,
          ) => Promise<string>)
        | undefined;

      if (cfg.privateKeyBase58) {
        const kp = await loadKeypair(cfg.privateKeyBase58);
        publicKey = kp.publicKey;
        signAndSend = kp.signAndSend;
      }

      if (wantLive) {
        assertLiveReady(cfg);
        if (!publicKey || !signAndSend) {
          throw new Error("Wallet key failed to load for live swap.");
        }
      }

      const client = new DflowClient(cfg);
      // Prefer fresh order; if prior quote had a transaction and pair matches, still re-quote for freshness
      const order = await client.getOrder({
        inputMint: parsed.input.mint,
        outputMint: parsed.output.mint,
        amount: atomic,
        userPublicKey: publicKey,
      });

      if (!wantLive) {
        const body = [
          "DFlow swap **preview** (not broadcast):",
          formatQuote(order, {
            inSymbol: parsed.input.symbol,
            outSymbol: parsed.output.symbol,
            humanIn: parsed.humanAmount,
          }),
          priorQuote
            ? "(Chained after DFLOW_QUOTE — pair/amount reused from plan.)"
            : "",
          "",
          "To execute live: set SOLANA_TRADE_LIVE=true, HELIUS_RPC_URL, SOLANA_PRIVATE_KEY,",
          "and say “execute swap … live”.",
        ]
          .filter(Boolean)
          .join("\n");
        if (callback) await callback({ text: body }, ACTION);
        return actionSuccess(
          ACTION,
          body,
          { mode: "preview", order, parsed, chainedFrom: "DFLOW_QUOTE" },
          {
            values: { lastSwapMode: "preview" },
            turnComplete: true,
            verifiedUserFacing: true,
          },
        );
      }

      if (!order.transaction) {
        throw new Error("DFlow returned no transaction for live swap.");
      }

      const sig = await signAndSend!(order, cfg.rpcUrl!);
      const body = [
        "DFlow swap **live** submitted.",
        `  ${parsed.humanAmount} ${parsed.input.symbol} → ${parsed.output.symbol}`,
        `  signature: ${sig}`,
        `  explorer: https://solscan.io/tx/${sig}`,
        `  outAmount (quoted atomic): ${order.outAmount ?? "n/a"}`,
      ].join("\n");
      if (callback) await callback({ text: body }, ACTION);
      return actionSuccess(
        ACTION,
        body,
        { mode: "live", signature: sig, order, parsed },
        {
          values: { lastSwapMode: "live", lastTx: sig },
          turnComplete: true,
          verifiedUserFacing: true,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const body = `DFlow swap failed: ${msg}`;
      if (callback) await callback({ text: body }, ACTION);
      return actionFailure(ACTION, body, err);
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Swap 0.01 SOL to USDC preview" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Building DFlow preview order…",
          actions: ["DFLOW_SWAP"],
        },
      },
    ],
  ],
};
