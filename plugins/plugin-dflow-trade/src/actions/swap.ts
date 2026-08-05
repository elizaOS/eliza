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
import { assertLiveReady, loadKeypair } from "../services/wallet.js";

export const dflowSwapAction: Action = {
  name: "DFLOW_SWAP",
  similes: [
    "SOLANA_SWAP",
    "EXECUTE_SWAP",
    "TRADE_SOLANA",
    "DFLOW_TRADE",
    "SWAP_TOKENS",
  ],
  description:
    "Preview or execute a Solana spot swap via DFlow. Default is preview (quote + unsigned tx info). Live sign/broadcast only when SOLANA_TRADE_LIVE=true and user says execute/live. Requires DFLOW_API_KEY, HELIUS_RPC_URL, SOLANA_PRIVATE_KEY for live.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /swap|trade|buy|sell|convert|execute\s+swap|dflow/i.test(text);
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
        "Could not parse swap. Try: “swap 0.01 SOL to USDC” or “execute swap 1 USDC to SOL live”.";
      if (callback) await callback({ text: body, actions: ["DFLOW_SWAP"] });
      return { success: false, text: body };
    }

    if (parsed.input.decimals == null) {
      const body = `Unknown decimals for ${parsed.input.symbol}. Use SOL/USDC/USDT or set decimals.`;
      if (callback) await callback({ text: body, actions: ["DFLOW_SWAP"] });
      return { success: false, text: body };
    }
    const atomic =
      parsed.atomicAmount ||
      toAtomicAmount(parsed.humanAmount, parsed.input.decimals);

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
          "",
          "To execute live: set SOLANA_TRADE_LIVE=true, HELIUS_RPC_URL, SOLANA_PRIVATE_KEY,",
          "and say “execute swap … live”.",
        ].join("\n");
        if (callback) await callback({ text: body, actions: ["DFLOW_SWAP"] });
        return {
          success: true,
          text: body,
          data: { mode: "preview", order, parsed },
          values: { lastSwapMode: "preview" },
        };
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
      if (callback) await callback({ text: body, actions: ["DFLOW_SWAP"] });
      return {
        success: true,
        text: body,
        data: { mode: "live", signature: sig, order, parsed },
        values: { lastSwapMode: "live", lastTx: sig },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const body = `DFlow swap failed: ${msg}`;
      if (callback) await callback({ text: body, actions: ["DFLOW_SWAP"] });
      return { success: false, text: body, error: err as Error };
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
