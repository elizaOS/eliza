/**
 * Action: hyperd.wallet.pnl
 *
 * Calls GET /api/wallet/pnl to compute realized + unrealized P&L for an EVM
 * address. ERC-20 + native, FIFO/LIFO/HCFO accounting. Per-token breakdown.
 * Cost: $0.05 in USDC on Base.
 *
 * Activated when the user asks "am I up", asks about P&L, or wants a
 * portfolio performance summary for a specific address.
 */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { HyperdClient, HyperdRequestError } from "../client.js";
import { resolveConfig } from "../config.js";
import type { WalletPnlResponse } from "../types.js";

const ADDR_RE = /0x[a-fA-F0-9]{40}/;
const CHAIN_RE = /\b(base|ethereum|eth|mainnet|polygon|arbitrum|optimism|avalanche|bnb)\b/i;

function extractAddress(text: string | undefined): string | null {
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

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export const walletPnlAction: Action = {
  name: "HYPERD_WALLET_PNL",
  description:
    "Compute realized + unrealized P&L for an EVM address. Returns total, realized, and unrealized USD amounts plus per-token breakdown with cost basis and market value. Use when the user asks 'am I up', 'how much have I made', wants P&L stats, or asks about portfolio performance.",
  similes: [
    "WALLET_PNL_CHECK",
    "PNL_CHECK",
    "PROFIT_AND_LOSS",
    "PORTFOLIO_PERFORMANCE",
    "AM_I_UP",
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
    const text = message?.content?.text;
    const address = extractAddress(text);
    const chain = extractChain(text);
    if (!address) {
      await callback?.({
        text: "I couldn't find an EVM address (0x...) in the message to check P&L.",
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
      const res = await client.get<WalletPnlResponse>("/api/wallet/pnl", {
        address,
        chain,
      });
      const lines: string[] = [];
      lines.push(`P&L for ${address} on ${chain} (${res.window}):`);
      lines.push(`• Total: ${fmtUsd(res.total_pnl_usd)}`);
      lines.push(`• Realized: ${fmtUsd(res.realized_pnl_usd)}`);
      lines.push(`• Unrealized: ${fmtUsd(res.unrealized_pnl_usd)}`);
      const top = [...res.per_token]
        .sort((a, b) => Math.abs(b.realized_pnl_usd + b.unrealized_pnl_usd) - Math.abs(a.realized_pnl_usd + a.unrealized_pnl_usd))
        .slice(0, 5);
      if (top.length > 0) {
        lines.push("• Top positions by impact:");
        for (const t of top) {
          const total = t.realized_pnl_usd + t.unrealized_pnl_usd;
          lines.push(`  · ${t.symbol}: ${fmtUsd(total)} (cost basis ${fmtUsd(t.cost_basis_usd)})`);
        }
      }
      await callback?.({
        text: lines.join("\n"),
        source: "hyperd",
        action: "HYPERD_WALLET_PNL",
      });
      return { success: true };
    } catch (err) {
      const errText = err instanceof HyperdRequestError
        ? `hyperD returned ${err.status}: ${err.message}`
        : `hyperD wallet-pnl call failed: ${err instanceof Error ? err.message : String(err)}`;
      await callback?.({ text: errText, source: "hyperd" });
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's my P&L? 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Computing realized + unrealized P&L...",
          action: "HYPERD_WALLET_PNL",
        },
      },
    ],
  ],
};
