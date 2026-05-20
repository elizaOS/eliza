#!/usr/bin/env bun

/**
 * Full Tick Runner
 *
 * Fires all cron endpoints in the correct production order and shows
 * a before/after perp price snapshot diff. Requires the dev server
 * running on localhost:3000.
 *
 * Usage:
 *   bun run tick:full
 *   bun run tick:full -- --loop --interval=30
 *   bun run tick:full -- --skip npc-tick,agent-tick
 *   bun run tick:full -- --only markets-tick
 */

import { parseArgs } from "node:util";
import { getRawDrizzle } from "@feed/db";
import { markets, perpMarketSnapshots } from "@feed/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    loop: { type: "boolean", default: false },
    interval: { type: "string", default: "60" },
    skip: { type: "string", default: "" },
    only: { type: "string", default: "" },
    host: { type: "string", default: "http://localhost:3000" },
  },
  strict: false,
});

const loopMode = args.loop ?? false;
const intervalSec = Math.max(5, Number.parseInt(args.interval ?? "60", 10));
const skipSet = new Set((args.skip ?? "").split(",").filter(Boolean));
const onlySet = new Set((args.only ?? "").split(",").filter(Boolean));
const BASE = (args.host ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET ?? "development";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const green = "\x1b[32m";
const red = "\x1b[31m";
const cyan = "\x1b[36m";
const dim = "\x1b[2m";

function ts(): string {
  return new Date().toLocaleTimeString();
}

interface CronResult {
  name: string;
  status: number;
  ok: boolean;
  durationMs: number;
  data: Record<string, unknown>;
}

async function callCron(name: string): Promise<CronResult> {
  const url = `${BASE}/api/cron/${name}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(120_000),
    });
    const durationMs = Date.now() - t0;
    const ct = res.headers.get("content-type") ?? "";
    let data: Record<string, unknown> = {};
    if (ct.includes("application/json")) {
      data = (await res.json()) as Record<string, unknown>;
    } else {
      const text = await res.text();
      data = { raw: text.slice(0, 300) };
    }
    return { name, status: res.status, ok: res.ok, durationMs, data };
  } catch (err) {
    return {
      name,
      status: 0,
      ok: false,
      durationMs: Date.now() - t0,
      data: { error: String(err) },
    };
  }
}

function shouldRun(name: string): boolean {
  if (onlySet.size > 0) return onlySet.has(name);
  return !skipSet.has(name);
}

function summarize(r: CronResult): string {
  const d = r.data;
  const parts: string[] = [];

  if (r.name === "game-tick") {
    if (d.skipped) return `skipped: ${d.reason}`;
    if (d.result) {
      const result = d.result as Record<string, unknown>;
      if (result.postsCreated) parts.push(`posts=${result.postsCreated}`);
      if (result.eventsCreated) parts.push(`events=${result.eventsCreated}`);
      if (result.marketsUpdated)
        parts.push(`marketsUpdated=${result.marketsUpdated}`);
    }
  } else if (r.name === "markets-tick") {
    if (d.resolved != null) parts.push(`resolved=${d.resolved}`);
    if (d.created != null) parts.push(`created=${d.created}`);
    if (d.active != null) parts.push(`active=${d.active}`);
    if (d.skipped != null && d.skipped)
      parts.push(`skipped: ${d.reason ?? ""}`);
  } else if (r.name === "npc-tick") {
    if (d.npcsProcessed != null) parts.push(`npcs=${d.npcsProcessed}`);
    if (d.postsCreated != null) parts.push(`posts=${d.postsCreated}`);
  } else if (r.name === "agent-tick") {
    if (d.processed != null) parts.push(`agents=${d.processed}`);
    if (d.totalActions != null) parts.push(`actions=${d.totalActions}`);
  }

  return parts.length > 0 ? parts.join("  ") : JSON.stringify(d).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Perp snapshot diff
// ---------------------------------------------------------------------------
interface PerpSnapshot {
  ticker: string;
  currentPrice: number;
  indexPrice: number | null;
  markPrice: number | null;
}

async function getPerpSnapshot(): Promise<PerpSnapshot[]> {
  const db = getRawDrizzle();
  const rows = await db
    .select({
      ticker: perpMarketSnapshots.ticker,
      currentPrice: perpMarketSnapshots.currentPrice,
      indexPrice: perpMarketSnapshots.indexPrice,
      markPrice: perpMarketSnapshots.markPrice,
    })
    .from(perpMarketSnapshots);
  return rows;
}

interface PredSnapshot {
  id: string;
  question: string;
  yesOdds: number;
  liquidity: number;
}

async function getPredSnapshot(): Promise<PredSnapshot[]> {
  const db = getRawDrizzle();
  const rows = await db
    .select({
      id: markets.id,
      question: markets.question,
      yesShares: markets.yesShares,
      noShares: markets.noShares,
      liquidity: markets.liquidity,
    })
    .from(markets)
    .where(eq(markets.resolved, false));

  return rows.map((r) => {
    const yes = Number(r.yesShares);
    const no = Number(r.noShares);
    const total = yes + no;
    return {
      id: r.id,
      question: r.question,
      yesOdds: total > 0 ? no / total : 0.5,
      liquidity: Number(r.liquidity),
    };
  });
}

function printPerpDiff(before: PerpSnapshot[], after: PerpSnapshot[]): void {
  const beforeMap = new Map(before.map((s) => [s.ticker, s]));
  const changed: Array<{ ticker: string; delta: number; deltaPct: number }> =
    [];

  for (const a of after) {
    const b = beforeMap.get(a.ticker);
    if (!b) continue;
    const delta = a.currentPrice - b.currentPrice;
    const deltaPct = b.currentPrice > 0 ? (delta / b.currentPrice) * 100 : 0;
    if (Math.abs(deltaPct) > 0.01) {
      changed.push({ ticker: a.ticker, delta, deltaPct });
    }
  }

  if (changed.length === 0) {
    console.log(`  ${dim}Perps: no price changes${reset}`);
    return;
  }

  console.log(`  ${bold}Perp price changes:${reset}`);
  for (const c of changed.sort(
    (a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct),
  )) {
    const sign = c.delta >= 0 ? "+" : "";
    const color = c.delta >= 0 ? green : red;
    console.log(
      `    ${c.ticker.padEnd(8)} ${color}${sign}${c.deltaPct.toFixed(2)}%${reset}`,
    );
  }
}

function printPredDiff(before: PredSnapshot[], after: PredSnapshot[]): void {
  const beforeMap = new Map(before.map((s) => [s.id, s]));
  const changed: Array<{ question: string; deltaOdds: number }> = [];

  for (const a of after) {
    const b = beforeMap.get(a.id);
    if (!b) continue;
    const deltaOdds = (a.yesOdds - b.yesOdds) * 100;
    if (Math.abs(deltaOdds) > 0.5) {
      changed.push({ question: a.question.slice(0, 45), deltaOdds });
    }
  }
  if (changed.length === 0) return;

  console.log(`  ${bold}Prediction odds changes:${reset}`);
  for (const c of changed.sort(
    (a, b) => Math.abs(b.deltaOdds) - Math.abs(a.deltaOdds),
  )) {
    const sign = c.deltaOdds >= 0 ? "+" : "";
    const color = c.deltaOdds >= 0 ? green : red;
    console.log(
      `    "${c.question}"  ${color}${sign}${c.deltaOdds.toFixed(1)}ppt${reset}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Single tick run
// ---------------------------------------------------------------------------
const TICK_ORDER = [
  "game-tick",
  "markets-tick",
  "npc-tick",
  "agent-tick",
] as const;

async function runTick(runNum: number): Promise<void> {
  console.log(`\n${bold}${cyan}=== Tick #${runNum} — ${ts()} ===${reset}`);

  const perpBefore = await getPerpSnapshot();
  const predBefore = await getPredSnapshot();

  for (const name of TICK_ORDER) {
    if (!shouldRun(name)) {
      console.log(`${dim}  ${name.padEnd(14)} skipped (--skip/--only)${reset}`);
      continue;
    }

    const r = await callCron(name);
    const icon = r.ok ? `${green}✓${reset}` : `${red}✗${reset}`;
    const dur = `${dim}${r.durationMs}ms${reset}`;
    const sum = summarize(r);
    console.log(
      `  ${icon} ${bold}${name.padEnd(14)}${reset} ${r.status}  ${dur}  ${sum}`,
    );

    if (!r.ok) {
      console.log(`    ${red}${JSON.stringify(r.data).slice(0, 200)}${reset}`);
    }
  }

  const perpAfter = await getPerpSnapshot();
  const predAfter = await getPredSnapshot();
  console.log("");
  printPerpDiff(perpBefore, perpAfter);
  printPredDiff(predBefore, predAfter);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`${bold}Feed Full Tick Runner${reset}  ${dim}${BASE}${reset}`);
  const active = TICK_ORDER.filter(shouldRun).join(", ");
  console.log(`${dim}Running: ${active}${reset}`);
  if (loopMode) {
    console.log(
      `${dim}Loop mode: every ${intervalSec}s — Ctrl+C to stop${reset}`,
    );
  }

  let runNum = 1;
  await runTick(runNum++);

  if (loopMode) {
    while (true) {
      await Bun.sleep(intervalSec * 1000);
      await runTick(runNum++);
    }
  }
}

main().catch((err) => {
  console.error("tick:full error:", err);
  process.exit(1);
});
