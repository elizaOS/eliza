/**
 * Action: hyperd.liquidation.risk
 *
 * Calls GET /api/liquidation/risk to compute a composite health factor across
 * Aave V3, Compound v3, Spark, and Morpho for an EVM address. Cost: $0.10.
 *
 * Pass chain=all in the query to fan out across all 7 supported EVM chains.
 * Activated when the user asks about liquidation risk, health factor, or
 * margin-call exposure on an address.
 */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { HyperdClient, HyperdRequestError } from "../client.js";
import { resolveConfig } from "../config.js";
import type { LiquidationRiskResponse } from "../types.js";

const ADDR_RE = /0x[a-fA-F0-9]{40}/;
const CHAIN_RE = /\b(base|ethereum|eth|mainnet|polygon|arbitrum|optimism|avalanche|bnb|all)\b/i;

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

export const liquidationRiskAction: Action = {
  name: "HYPERD_LIQUIDATION_RISK",
  description:
    "Compute a composite cross-protocol liquidation health factor for an EVM address across Aave V3, Compound v3, Spark, and Morpho. Returns per-protocol position breakdown plus a recommended add-collateral threshold. Use when the user asks 'am I about to get liquidated', wants to check health factor, or asks about margin-call exposure.",
  similes: [
    "LIQUIDATION_CHECK",
    "HEALTH_FACTOR_CHECK",
    "MARGIN_CALL_CHECK",
    "CHECK_LIQUIDATION",
    "AAVE_HEALTH",
    "COMPOUND_HEALTH",
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
        text: "I couldn't find an EVM address (0x...) in the message to check liquidation risk.",
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
      const res = await client.get<LiquidationRiskResponse>("/api/liquidation/risk", {
        address,
        chain,
      });
      const lines: string[] = [];
      lines.push(`Liquidation risk for ${address} on ${chain}:`);
      if (res.positions.length === 0 || res.composite_health_factor === null) {
        lines.push("• No active borrow positions across Aave / Compound / Spark / Morpho.");
      } else {
        lines.push(`• Composite health factor: ${res.composite_health_factor.toFixed(2)}`);
        if (res.liquidation_imminent) lines.push("• ⚠ LIQUIDATION IMMINENT (HF < 1.05)");
        for (const p of res.positions) {
          lines.push(
            `  · ${p.protocol}: HF ${p.health_factor.toFixed(2)}, collateral $${p.collateral_usd.toFixed(0)}, debt $${p.debt_usd.toFixed(0)}`,
          );
        }
        if (res.recommended_add_collateral_usd !== undefined && res.recommended_add_collateral_usd > 0) {
          lines.push(
            `• Recommended add-collateral: $${res.recommended_add_collateral_usd.toFixed(0)} to reach HF 1.5`,
          );
        }
      }
      await callback?.({
        text: lines.join("\n"),
        source: "hyperd",
        action: "HYPERD_LIQUIDATION_RISK",
      });
      return { success: true };
    } catch (err) {
      const errText = err instanceof HyperdRequestError
        ? `hyperD returned ${err.status}: ${err.message}`
        : `hyperD liquidation-risk call failed: ${err instanceof Error ? err.message : String(err)}`;
      await callback?.({ text: errText, source: "hyperd" });
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Am I about to get liquidated? 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Checking liquidation health across Aave, Compound, Spark, and Morpho...",
          action: "HYPERD_LIQUIDATION_RISK",
        },
      },
    ],
  ],
};
