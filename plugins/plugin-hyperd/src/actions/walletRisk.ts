/**
 * Action: hyperd.wallet.risk
 *
 * Calls GET /api/risk/wallet to score an EVM address against Chainalysis
 * Sanctions Oracle + GoPlus heuristics. Cost: $0.10 in USDC on Base.
 *
 * Activated when the user asks anything resembling "is this address safe"
 * about a 0x-prefixed hex address present in the message.
 */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { HyperdClient, HyperdRequestError } from "../client.js";
import { resolveConfig } from "../config.js";
import type { WalletRiskResponse } from "../types.js";

const ADDR_RE = /0x[a-fA-F0-9]{40}/;

function extractAddress(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(ADDR_RE);
  return m ? m[0] : null;
}

export const walletRiskAction: Action = {
  name: "HYPERD_WALLET_RISK",
  description:
    "Score an EVM address for sanctions exposure and behavioural risk using Chainalysis Sanctions Oracle plus GoPlus heuristics. Use when the user asks whether an address is safe to interact with, asks about OFAC/sanctions status, or wants a risk assessment of a wallet.",
  similes: [
    "WALLET_RISK_CHECK",
    "SANCTIONS_CHECK",
    "ADDRESS_SAFETY_CHECK",
    "OFAC_CHECK",
    "CHECK_WALLET_RISK",
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return extractAddress(message?.content?.text) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ) => {
    const address = extractAddress(message?.content?.text);
    if (!address) {
      const text = "I couldn't find an EVM address (0x...) in the message to check.";
      await callback?.({ text, source: "hyperd" });
      return { success: false };
    }

    let client: HyperdClient;
    try {
      client = new HyperdClient(resolveConfig(runtime));
    } catch (err) {
      const text = `hyperD plugin misconfigured: ${err instanceof Error ? err.message : String(err)}`;
      await callback?.({ text, source: "hyperd" });
      return { success: false };
    }

    try {
      const res = await client.get<WalletRiskResponse>("/api/risk/wallet", { address });
      const lines = [
        `Wallet risk for ${address}:`,
        `• Sanctioned: ${res.sanctioned ? "YES — OFAC SDN listed" : "no"}`,
        `• Risk tier: ${res.risk_tier}`,
        res.categories.length > 0 ? `• Tags: ${res.categories.join(", ")}` : "• Tags: none",
      ];
      const text = lines.join("\n");
      await callback?.({
        text,
        source: "hyperd",
        action: "HYPERD_WALLET_RISK",
      });
      return { success: true };
    } catch (err) {
      const text = err instanceof HyperdRequestError
        ? `hyperD returned ${err.status}: ${err.message}`
        : `hyperD wallet-risk call failed: ${err instanceof Error ? err.message : String(err)}`;
      await callback?.({ text, source: "hyperd" });
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Is 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 safe to send to?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Checking address risk via hyperD...",
          action: "HYPERD_WALLET_RISK",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "OFAC check on 0x1234567890123456789012345678901234567890" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Running sanctions check on that address...",
          action: "HYPERD_WALLET_RISK",
        },
      },
    ],
  ],
};
