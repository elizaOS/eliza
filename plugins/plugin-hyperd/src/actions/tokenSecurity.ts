/**
 * Action: hyperd.token.security
 *
 * Calls GET /api/token/security to assess an ERC-20 contract via GoPlus
 * security scoring (0–100). Cost: $0.05 in USDC on Base.
 *
 * Activated when the user asks if a token is safe, asks about honeypot risk,
 * owner permissions, taxes, or holder concentration on a specific contract.
 */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { HyperdClient, HyperdRequestError } from "../client.js";
import { resolveConfig } from "../config.js";
import type { TokenSecurityResponse } from "../types.js";

const ADDR_RE = /0x[a-fA-F0-9]{40}/;
const CHAIN_RE = /\b(base|ethereum|eth|mainnet|polygon|arbitrum|optimism|avalanche|bnb)\b/i;

function extractContract(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(ADDR_RE);
  return m ? m[0] : null;
}

function extractChain(text: string | undefined): string {
  if (!text) return "base";
  const m = text.match(CHAIN_RE);
  if (!m) return "base";
  const v = m[0].toLowerCase();
  if (v === "eth" || v === "mainnet") return "ethereum";
  return v;
}

export const tokenSecurityAction: Action = {
  name: "HYPERD_TOKEN_SECURITY",
  description:
    "Run a GoPlus security scan on an ERC-20 token contract. Returns a 0–100 security score plus flags for honeypot, owner mint/blacklist permissions, buy/sell taxes, and top-10 holder concentration. Use when the user asks 'is this token a scam', wants honeypot detection, or asks about token safety before swapping.",
  similes: [
    "TOKEN_SECURITY_CHECK",
    "TOKEN_SCAM_CHECK",
    "HONEYPOT_CHECK",
    "GOPLUS_SCAN",
    "CHECK_TOKEN_SAFETY",
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return extractContract(message?.content?.text) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ) => {
    const text = message?.content?.text;
    const contract = extractContract(text);
    const chain = extractChain(text);
    if (!contract) {
      await callback?.({
        text: "I couldn't find a contract address (0x...) in the message to scan.",
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
      const res = await client.get<TokenSecurityResponse>("/api/token/security", {
        contract,
        chain,
      });
      const flags: string[] = [];
      if (res.honeypot) flags.push("HONEYPOT DETECTED");
      if (res.owner_can_mint) flags.push("owner can mint");
      if (res.owner_can_blacklist) flags.push("owner can blacklist");
      if (res.buy_tax_pct > 5) flags.push(`buy tax ${res.buy_tax_pct.toFixed(1)}%`);
      if (res.sell_tax_pct > 5) flags.push(`sell tax ${res.sell_tax_pct.toFixed(1)}%`);
      if (res.holder_concentration_top10_pct > 50) {
        flags.push(`top-10 holders own ${res.holder_concentration_top10_pct.toFixed(0)}%`);
      }
      const lines = [
        `Token security for ${contract} on ${chain}:`,
        `• Security score: ${res.security_score}/100`,
        flags.length > 0 ? `• Flags: ${flags.join(", ")}` : "• Flags: none",
      ];
      await callback?.({
        text: lines.join("\n"),
        source: "hyperd",
        action: "HYPERD_TOKEN_SECURITY",
      });
      return { success: true };
    } catch (err) {
      const errText = err instanceof HyperdRequestError
        ? `hyperD returned ${err.status}: ${err.message}`
        : `hyperD token-security call failed: ${err instanceof Error ? err.message : String(err)}`;
      await callback?.({ text: errText, source: "hyperd" });
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Is 0x4200000000000000000000000000000000000006 a scam token?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Running GoPlus security scan...",
          action: "HYPERD_TOKEN_SECURITY",
        },
      },
    ],
  ],
};
