import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { formatReadiness, readDflowTradeConfig } from "../config.js";

/**
 * Injects trade env readiness + natural-language usage hints so DeepSeek/etc.
 * agents know they can quote/swap via DFlow when keys are present.
 */
export const dflowTradeContextProvider: Provider = {
  name: "DFLOW_TRADE_CONTEXT",
  description:
    "Solana DFlow trading context: API/RPC/live flags and how to quote or swap",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const cfg = readDflowTradeConfig((k) =>
      runtime.getSetting?.(k) as string | undefined,
    );
    const text = [
      formatReadiness(cfg),
      "",
      "When the user wants to trade on Solana, use DFLOW_QUOTE / DFLOW_SWAP.",
      "Never invent tx signatures. Preview by default; live only when SOLANA_TRADE_LIVE and user confirms.",
      "Atomic units: 1 SOL = 1_000_000_000 lamports; 1 USDC = 1_000_000.",
    ].join("\n");

    return {
      text,
      data: {
        tradeApiUrl: cfg.tradeApiUrl,
        hasDflowKey: Boolean(cfg.apiKey),
        hasRpc: Boolean(cfg.rpcUrl),
        liveEnabled: cfg.liveEnabled,
        deepseekConfigured: cfg.deepseekConfigured,
      },
      values: {
        dflowTradeReady: Boolean(cfg.rpcUrl),
        dflowLiveEnabled: cfg.liveEnabled,
      },
    };
  },
};
