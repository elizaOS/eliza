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
import { formatReadiness, readDflowTradeConfig } from "../config.js";
import { getSolBalanceLamports, loadKeypair } from "../services/wallet.js";

const ACTION = "DFLOW_TRADE_STATUS";

export const dflowBalanceAction: Action = {
  name: ACTION,
  similes: [
    "SOLANA_BALANCE",
    "WALLET_BALANCE",
    "TRADE_READINESS",
    "DFLOW_STATUS",
  ],
  description:
    "Show DFlow/Helius/DeepSeek trade readiness and optional SOL balance. Useful as step 0 before DFLOW_QUOTE/DFLOW_SWAP.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /balance|readiness|trade status|wallet status|can i trade|dflow status/i.test(
      text,
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const cfg = readDflowTradeConfig((k) =>
      runtime.getSetting?.(k) as string | undefined,
    );
    const lines = [formatReadiness(cfg)];

    if (cfg.privateKeyBase58 && cfg.rpcUrl) {
      try {
        const kp = await loadKeypair(cfg.privateKeyBase58);
        const lamports = await getSolBalanceLamports(cfg.rpcUrl, kp.publicKey);
        const sol = lamports / 1e9;
        lines.push(
          "",
          `Wallet: ${kp.publicKey}`,
          `SOL balance: ${sol.toFixed(6)} SOL (${lamports} lamports)`,
        );
      } catch (err) {
        lines.push(
          "",
          `Wallet/balance error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const body = lines.join("\n");
    if (callback) await callback({ text: body }, ACTION);
    return actionSuccess(
      ACTION,
      body,
      {
        hasDflowKey: Boolean(cfg.apiKey),
        hasRpc: Boolean(cfg.rpcUrl),
        liveEnabled: cfg.liveEnabled,
        deepseekConfigured: cfg.deepseekConfigured,
      },
      { turnComplete: true, verifiedUserFacing: true },
    );
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Can I trade? Show trade readiness and balance" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Checking DFlow + Helius readiness…",
          actions: ["DFLOW_TRADE_STATUS"],
        },
      },
    ],
  ],
};
