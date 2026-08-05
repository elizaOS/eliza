import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { formatReadiness, readDflowTradeConfig } from "../config.js";
import {
  getSolBalanceLamports,
  loadKeypair,
} from "../services/wallet.js";

export const dflowBalanceAction: Action = {
  name: "DFLOW_TRADE_STATUS",
  similes: [
    "SOLANA_BALANCE",
    "WALLET_BALANCE",
    "TRADE_READINESS",
    "DFLOW_STATUS",
  ],
  description:
    "Show DFlow/Helius/DeepSeek trade readiness and optional SOL balance for the configured wallet.",
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
    _options?: unknown,
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
    if (callback) await callback({ text: body, actions: ["DFLOW_TRADE_STATUS"] });
    return { success: true, text: body, data: { cfg } };
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
