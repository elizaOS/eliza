#!/usr/bin/env bun

/**
 * Market Health Report
 *
 * Direct-DB snapshot of prediction market + perp health.
 * No server required — reads live DB state and flags problems instantly.
 *
 * Usage:
 *   bun run report:markets:health
 *   bun run report:markets:health -- --json
 *   bun run report:markets:health -- --watch --interval=30
 */

import { parseArgs } from "node:util";
import { getRawDrizzle } from "@feed/db";
import {
  markets,
  perpMarketSnapshots,
  predictionPriceHistories,
} from "@feed/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    interval: { type: "string", default: "30" },
  },
  strict: false,
});

const outputJson = args.json ?? false;
const watchMode = args.watch ?? false;
const intervalSec = Math.max(5, Number.parseInt(args.interval ?? "30", 10));

// ---------------------------------------------------------------------------
// Thresholds (named so they're easy to tune)
// ---------------------------------------------------------------------------
const PRED_EXTREME_LOW = 0.05; // odds below this → EXTREME
const PRED_EXTREME_HIGH = 0.95; // odds above this → EXTREME
const PRED_THIN_LIQUIDITY = 5_000; // USD below this → THIN
const PRED_HISTORY_WINDOW_MIN = 60; // minutes of history to check for swing
const PRED_SWING_WARN_PCT = 30; // % swing in window → VOLATILE

const PERP_STALE_INDEX_PCT = 0.1; // |current - index| / index → STALE_INDEX
const PERP_HIGH_FUNDING_APR = 0.3; // annual funding rate magnitude → HIGH_FUNDING
const PERP_STALE_QUOTE_MIN = 30; // minutes since quoteUpdatedAt → STALE_QUOTE

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const red = "\x1b[31m";
const yellow = "\x1b[33m";
const green = "\x1b[32m";
const cyan = "\x1b[36m";
const dim = "\x1b[2m";

const OK = `${green}[OK]  ${reset}`;
const WARN = `${yellow}[WARN]${reset}`;

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function price(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PredictionFlag {
  label: string;
  type: "EXTREME" | "THIN" | "VOLATILE" | "EXPIRED_ACTIVE";
}

interface PredictionMarketHealth {
  id: string;
  question: string;
  yesOdds: number;
  noOdds: number;
  liquidity: number;
  endDate: Date;
  resolved: boolean;
  swingPct?: number;
  flags: PredictionFlag[];
}

interface PerpFlag {
  label: string;
  type:
    | "STALE_INDEX"
    | "HIGH_FUNDING"
    | "STALE_QUOTE"
    | "PRICE_EXTREME"
    | "INVALID_PRICE";
}

interface PerpMarketHealth {
  ticker: string;
  currentPrice: number;
  indexPrice?: number | null;
  markPrice?: number | null;
  spreadBps?: number | null;
  fundingRateAnnual: number;
  quoteUpdatedAt?: Date | null;
  openInterest: number;
  flags: PerpFlag[];
}

interface HealthReport {
  generatedAt: string;
  predictions: {
    total: number;
    healthy: number;
    warnings: number;
    markets: PredictionMarketHealth[];
  };
  perps: {
    total: number;
    healthy: number;
    warnings: number;
    markets: PerpMarketHealth[];
  };
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------
async function analyzeMarkets(): Promise<HealthReport> {
  const db = getRawDrizzle();
  const now = new Date();
  const historyFrom = new Date(
    now.getTime() - PRED_HISTORY_WINDOW_MIN * 60_000,
  );

  // --- Prediction markets ---
  const activeMarkets = await db
    .select()
    .from(markets)
    .where(eq(markets.resolved, false));

  const predictionResults: PredictionMarketHealth[] = [];

  for (const market of activeMarkets) {
    const yesShares = Number(market.yesShares);
    const noShares = Number(market.noShares);
    const total = yesShares + noShares;
    const yesOdds = total > 0 ? noShares / total : 0.5;
    const noOdds = total > 0 ? yesShares / total : 0.5;
    const liquidity = Number(market.liquidity);

    const flags: PredictionFlag[] = [];

    if (yesOdds < PRED_EXTREME_LOW || yesOdds > PRED_EXTREME_HIGH) {
      flags.push({
        type: "EXTREME",
        label: `YES odds ${pct(yesOdds)} (outside ${pct(PRED_EXTREME_LOW)}–${pct(PRED_EXTREME_HIGH)})`,
      });
    }
    if (liquidity < PRED_THIN_LIQUIDITY) {
      flags.push({
        type: "THIN",
        label: `liquidity ${usd(liquidity)} (< ${usd(PRED_THIN_LIQUIDITY)} threshold)`,
      });
    }
    if (market.endDate < now) {
      flags.push({
        type: "EXPIRED_ACTIVE",
        label: `endDate ${market.endDate.toISOString()} is in the past (unresolved)`,
      });
    }

    // Recent price swing
    const history = await db
      .select({
        yesPrice: predictionPriceHistories.yesPrice,
        createdAt: predictionPriceHistories.createdAt,
      })
      .from(predictionPriceHistories)
      .where(
        and(
          eq(predictionPriceHistories.marketId, market.id),
          gte(predictionPriceHistories.createdAt, historyFrom),
        ),
      )
      .orderBy(desc(predictionPriceHistories.createdAt))
      .limit(50);

    let swingPct: number | undefined;
    if (history.length >= 2) {
      const prices = history.map((h) => h.yesPrice);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      swingPct = (maxP - minP) * 100;
      if (swingPct > PRED_SWING_WARN_PCT) {
        flags.push({
          type: "VOLATILE",
          label: `${swingPct.toFixed(1)}ppt swing in last ${PRED_HISTORY_WINDOW_MIN}min (> ${PRED_SWING_WARN_PCT}ppt threshold)`,
        });
      }
    }

    predictionResults.push({
      id: market.id,
      question: market.question,
      yesOdds,
      noOdds,
      liquidity,
      endDate: market.endDate,
      resolved: market.resolved,
      swingPct,
      flags,
    });
  }

  // --- Perp markets ---
  const perpSnapshots = await db.select().from(perpMarketSnapshots);

  const perpResults: PerpMarketHealth[] = [];

  for (const snap of perpSnapshots) {
    const flags: PerpFlag[] = [];
    const fundingRateAnnual =
      typeof snap.fundingRate === "object" && snap.fundingRate !== null
        ? ((snap.fundingRate as { rate?: number }).rate ?? 0)
        : 0;

    if (!Number.isFinite(snap.currentPrice) || snap.currentPrice <= 0) {
      flags.push({
        type: "INVALID_PRICE",
        label: `currentPrice invalid: ${snap.currentPrice}`,
      });
    }

    if (
      snap.indexPrice != null &&
      snap.indexPrice > 0 &&
      Number.isFinite(snap.indexPrice)
    ) {
      const drift =
        Math.abs(snap.currentPrice - snap.indexPrice) / snap.indexPrice;
      if (drift > PERP_STALE_INDEX_PCT) {
        flags.push({
          type: "STALE_INDEX",
          label: `indexPrice ${price(snap.indexPrice)} vs currentPrice ${price(snap.currentPrice)} (${pct(drift)} drift)`,
        });
      }
    }

    if (Math.abs(fundingRateAnnual) > PERP_HIGH_FUNDING_APR) {
      flags.push({
        type: "HIGH_FUNDING",
        label: `annual funding rate ${pct(fundingRateAnnual)} (> ${pct(PERP_HIGH_FUNDING_APR)} threshold)`,
      });
    }

    if (snap.quoteUpdatedAt != null) {
      const ageMins = (now.getTime() - snap.quoteUpdatedAt.getTime()) / 60_000;
      if (ageMins > PERP_STALE_QUOTE_MIN) {
        flags.push({
          type: "STALE_QUOTE",
          label: `quote last updated ${ageMins.toFixed(0)}min ago (> ${PERP_STALE_QUOTE_MIN}min)`,
        });
      }
    }

    perpResults.push({
      ticker: snap.ticker,
      currentPrice: snap.currentPrice,
      indexPrice: snap.indexPrice,
      markPrice: snap.markPrice,
      spreadBps: snap.spreadBps,
      fundingRateAnnual,
      quoteUpdatedAt: snap.quoteUpdatedAt,
      openInterest: snap.openInterest,
      flags,
    });
  }

  const predWarnings = predictionResults.filter(
    (m) => m.flags.length > 0,
  ).length;
  const perpWarnings = perpResults.filter((m) => m.flags.length > 0).length;

  return {
    generatedAt: now.toISOString(),
    predictions: {
      total: predictionResults.length,
      healthy: predictionResults.length - predWarnings,
      warnings: predWarnings,
      markets: predictionResults,
    },
    perps: {
      total: perpResults.length,
      healthy: perpResults.length - perpWarnings,
      warnings: perpWarnings,
      markets: perpResults,
    },
  };
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------
function renderText(report: HealthReport): void {
  console.clear();
  console.log(
    `\n${bold}${cyan}Market Health Report${reset}  ${dim}${report.generatedAt}${reset}\n`,
  );

  // --- Predictions ---
  console.log(`${bold}=== PREDICTION MARKETS ===${reset}`);
  const { predictions } = report;

  if (predictions.total === 0) {
    console.log(`${dim}  No active prediction markets${reset}`);
  } else {
    for (const m of predictions.markets) {
      const hasFlags = m.flags.length > 0;
      const prefix = hasFlags ? WARN : OK;
      const question =
        m.question.length > 55 ? `${m.question.slice(0, 52)}...` : m.question;
      const oddsStr = `YES ${pct(m.yesOdds)}`;
      const swingStr =
        m.swingPct != null ? `  swing ${m.swingPct.toFixed(1)}ppt` : "";
      console.log(
        `${prefix} "${question}"  ${oddsStr}  liq ${usd(m.liquidity)}${swingStr}`,
      );
      for (const f of m.flags) {
        const icon =
          f.type === "VOLATILE"
            ? yellow
            : f.type === "EXPIRED_ACTIVE"
              ? red
              : yellow;
        console.log(`       ${icon}↳ ${f.type}: ${f.label}${reset}`);
      }
    }
    const summary =
      predictions.warnings === 0
        ? `${OK}${green} ${predictions.healthy}/${predictions.total} markets healthy${reset}`
        : `${WARN} ${predictions.healthy}/${predictions.total} healthy — ${predictions.warnings} warning(s)`;
    console.log(`\n  ${summary}`);
  }

  // --- Perps ---
  console.log(`\n${bold}=== PERP MARKETS ===${reset}`);
  const { perps } = report;

  if (perps.total === 0) {
    console.log(`${dim}  No perp markets${reset}`);
  } else {
    // Sort: warnings first
    const sorted = [...perps.markets].sort(
      (a, b) => b.flags.length - a.flags.length,
    );
    for (const m of sorted) {
      const hasFlags = m.flags.length > 0;
      const prefix = hasFlags ? WARN : OK;
      const spread =
        m.spreadBps != null ? `  spread ${m.spreadBps.toFixed(0)}bps` : "";
      const funding = `  funding ${pct(m.fundingRateAnnual)}/yr`;
      const oi = `  OI ${usd(m.openInterest)}`;
      console.log(
        `${prefix} ${m.ticker.padEnd(8)} cur ${price(m.currentPrice)}  idx ${m.indexPrice != null ? price(m.indexPrice) : "n/a"}  mrk ${m.markPrice != null ? price(m.markPrice) : "n/a"}${spread}${funding}${oi}`,
      );
      for (const f of m.flags) {
        const icon = f.type === "INVALID_PRICE" ? red : yellow;
        console.log(`           ${icon}↳ ${f.type}: ${f.label}${reset}`);
      }
    }
    const summary =
      perps.warnings === 0
        ? `${OK}${green} ${perps.healthy}/${perps.total} perp markets healthy${reset}`
        : `${WARN} ${perps.healthy}/${perps.total} healthy — ${perps.warnings} warning(s)`;
    console.log(`\n  ${summary}`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (watchMode) {
    console.log(
      `${dim}Watching market health every ${intervalSec}s — Ctrl+C to stop${reset}`,
    );
    while (true) {
      const report = await analyzeMarkets();
      if (outputJson) {
        console.clear();
        console.log(JSON.stringify(report, null, 2));
      } else {
        renderText(report);
      }
      await Bun.sleep(intervalSec * 1000);
    }
  } else {
    const report = await analyzeMarkets();
    if (outputJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      renderText(report);
    }
  }
}

main().catch((err) => {
  console.error("market-health error:", err);
  process.exit(1);
});
