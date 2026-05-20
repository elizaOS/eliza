/**
 * Shared Trading Dashboard Formatting
 *
 * Canonical helpers for formatting NPC trading dashboards and market tables.
 * Used by both MarketDecisionEngine (LLM prompt) and dev tools (context-inspector).
 *
 * Extracted from MarketDecisionEngine private methods to enable reuse
 * without behavioral drift.
 */

import {
  formatTradingStrategyBias,
  getNpcTradingStrategy,
  TRADING_STRATEGIES,
} from "../npc/trading-strategies";
import type { NPCMarketContext, NPCPosition } from "../types/market-context";

/**
 * Map a free-text personality description to a trading archetype label.
 *
 * Mirrors the logic previously private on MarketDecisionEngine.
 */
export function mapPersonalityToArchetype(personality: string): string {
  const p = personality.toLowerCase();
  if (
    p.includes("risk") ||
    p.includes("aggressive") ||
    p.includes("degen") ||
    p.includes("speculator")
  ) {
    return "DEGEN_TRADER";
  }
  if (
    p.includes("cautious") ||
    p.includes("conservative") ||
    p.includes("manager")
  ) {
    return "RISK_MANAGER";
  }
  if (p.includes("analytical") || p.includes("quant") || p.includes("math")) {
    return "QUANT_TRADER";
  }
  if (p.includes("insider") || p.includes("connected")) {
    return "INSIDER";
  }
  return "SYSTEMATIC_TRADER";
}

/**
 * Calculate portfolio exposure as a percentage of total equity.
 *
 * Formula: (totalPositionValue / totalEquity) × 100
 * where totalPositionValue = Σ(size + unrealizedPnL)
 * and   totalEquity        = cash + totalPositionValue
 *
 * Clamped to [0, 100].
 */
export function calculatePortfolioExposure(
  balance: number,
  positions: Pick<NPCPosition, "size" | "unrealizedPnL">[],
): number {
  const totalPositionValue = positions.reduce(
    (sum, p) => sum + p.size + p.unrealizedPnL,
    0,
  );
  const totalEquity = balance + totalPositionValue;

  if (totalEquity <= 0) return 0;
  return Math.min(100, Math.max(0, (totalPositionValue / totalEquity) * 100));
}

/**
 * Format a single NPC's trading dashboard block.
 *
 * Produces the same output as MarketDecisionEngine.formatNPCsList per entry.
 * @param ctx   - Full NPC market context
 * @param index - Optional 1-based index for multi-NPC listings
 */
export function formatSingleNPCDashboard(
  ctx: NPCMarketContext,
  index?: number,
): string {
  const archetype = mapPersonalityToArchetype(ctx.personality);
  const strategyKey = getNpcTradingStrategy(ctx.npcId);
  const strategy = TRADING_STRATEGIES[strategyKey];
  const exposure = calculatePortfolioExposure(
    ctx.availableBalance,
    ctx.currentPositions,
  );

  const totalPnL = ctx.currentPositions.reduce(
    (sum, p) => sum + p.unrealizedPnL,
    0,
  );
  const pnlSign = totalPnL >= 0 ? "+" : "";

  const allPositions = [...ctx.currentPositions]
    .sort((a, b) => Math.abs(b.unrealizedPnL) - Math.abs(a.unrealizedPnL))
    .map((p) => {
      const symbol = p.marketType === "perp" ? p.ticker : `Q${p.marketId}`;
      const posSign = p.unrealizedPnL >= 0 ? "+" : "";
      return `${symbol} ${p.side} ($${p.size.toFixed(0)}, PnL: ${posSign}$${p.unrealizedPnL.toFixed(0)}) [ID:${p.id}]`;
    })
    .join(", ");

  const relationships =
    ctx.relationships && ctx.relationships.length > 0
      ? ctx.relationships
          .filter((r) => Math.abs(r.sentiment) > 0.4)
          .slice(0, 6)
          .map((r) => `${r.sentiment > 0 ? "Ally" : "Rival"}:${r.actorName}`)
          .join(", ")
      : "None";

  const privateIntel =
    ctx.groupChatMessages.length > 0
      ? ctx.groupChatMessages
          .slice(0, 5)
          .map((m) => `"${m.fromName}: ${m.message}"`)
          .join(" | ")
      : "None";

  const prefix = index !== undefined ? `[${index}] ` : "";

  // Character voice context for in-character trading reasoning
  const voiceHint =
    "voice" in ctx && ctx.voice
      ? `Voice: ${String(ctx.voice).slice(0, 120)}`
      : "";
  const domainsHint =
    "domains" in ctx && ctx.domains
      ? `Expertise: ${((ctx.domains as string[]) ?? []).join(", ")}`
      : "";

  return `${prefix}TRADER DASHBOARD
ID: ${ctx.npcId} | Name: ${ctx.npcName}
Archetype: ${archetype} | Strategy: ${strategy.label} (${strategyKey})
${voiceHint ? `${voiceHint}\n` : ""}${domainsHint ? `${domainsHint}\n` : ""}Bias: ${formatTradingStrategyBias(strategy)} | Cash: $${ctx.availableBalance.toLocaleString()}
Total PnL: ${pnlSign}$${totalPnL.toFixed(0)} | Exposure: ${exposure.toFixed(1)}%
Network: ${relationships}
Positions: ${allPositions || "None"}
PRIVATE INTEL: ${privateIntel}`;
}

/**
 * Format an array of NPC contexts into a separator-delimited dashboard list.
 *
 * Direct replacement for MarketDecisionEngine.formatNPCsList.
 */
export function formatNPCsDashboardList(contexts: NPCMarketContext[]): string {
  return contexts
    .map((ctx, i) => formatSingleNPCDashboard(ctx, i + 1))
    .join("\n----------------------------------------\n");
}

/**
 * Format the shared market data table shown to all NPCs.
 *
 * Direct replacement for MarketDecisionEngine.formatMarketTable.
 * Takes a single context (all NPCs see the same market state).
 */
export function formatMarketDataTable(ctx: NPCMarketContext): string {
  const perps = ctx.perpMarkets || [];
  const predictions = ctx.predictionMarkets || [];

  if (perps.length === 0 && predictions.length === 0) {
    return "No Market Data Available";
  }

  let table =
    "| Ticker/ID | Type | Price | 24h Change | 24h Range | Context | Vol / MaxBet |\n|---|---|---|---|---|---|---|\n";

  for (const p of perps) {
    const sign = p.changePercent24h >= 0 ? "+" : "";
    const range = `$${p.low24h.toFixed(2)}-$${p.high24h.toFixed(2)}`;
    table += `| ${p.ticker} | PERP | $${p.currentPrice.toFixed(2)} | ${sign}${p.changePercent24h.toFixed(2)}% | ${range} | spot | $${(p.volume24h / 1000).toFixed(1)}k / — |\n`;
  }

  for (const p of predictions) {
    const daysLeft = p.daysUntilResolution;
    const safeText = p.text.replace(/\|/g, "/");
    const contextLabel = `${p.horizonBucket} / ${p.liquidityTier} / ${p.urgencyLevel} / ${p.eventSensitivity}`;
    const maxBetLabel =
      p.maxSafeBet > 0 ? `$${(p.maxSafeBet / 1000).toFixed(1)}k` : "thin";
    table += `| ${p.id} | PRED | Yes: ${p.yesPrice.toFixed(0)}¢ / No: ${p.noPrice.toFixed(0)}¢ | ${daysLeft}d left | "${safeText}" | ${contextLabel} | $${(p.totalVolume / 1000).toFixed(1)}k / max ${maxBetLabel} |\n`;
  }

  return table;
}
