#!/usr/bin/env bun

/**
 * Market Diversity Report
 *
 * Audits active prediction markets for diversity across topics,
 * entities, timeframes, categories, and near-duplicates.
 */

import { parseArgs } from "node:util";
import { getRawDrizzle } from "@feed/db";
import { organizations, questions, timeframedMarkets } from "@feed/db/schema";
import { and, eq, gte } from "drizzle-orm";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    history: { type: "string", short: "h" },
    verbose: { type: "boolean", short: "v", default: false },
  },
  strict: true,
});

const verbose = args.verbose ?? false;
const historyDays = args.history ? Number.parseInt(args.history, 10) : 0;
if (args.history && Number.isNaN(historyDays)) {
  console.error(crit("Invalid --history value: must be a number"));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "will",
  "be",
  "by",
  "to",
  "of",
  "in",
  "for",
  "and",
  "or",
  "this",
  "that",
  "with",
  "on",
  "at",
  "it",
  "its",
  "as",
  "are",
  "was",
  "were",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "not",
  "no",
  "but",
  "if",
  "so",
  "than",
  "too",
  "very",
  "can",
  "could",
  "would",
  "should",
  "may",
  "might",
  "shall",
  "from",
  "about",
  "up",
  "out",
  "into",
  "over",
  "after",
  "before",
  "between",
  "under",
  "again",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "any",
]);

const MARKET_STRUCTURE: Record<string, number> = {
  "3d": 1,
  "2d": 1,
  "1d": 1,
  "12h": 1,
  "6h": 1,
  "1h": 1,
  "30m": 2,
  "15m": 2,
};

// ANSI helpers
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const GRN = "\x1b[32m";
const RST = "\x1b[0m";

const warn = (s: string) => `${YEL}${s}${RST}`;
const crit = (s: string) => `${RED}${s}${RST}`;
const ok = (s: string) => `${GRN}${s}${RST}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function addPairToClusters(
  clusters: Set<number>[],
  leftIndex: number,
  rightIndex: number,
): void {
  const matchingClusterIndexes: number[] = [];

  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index];
    if (cluster.has(leftIndex) || cluster.has(rightIndex)) {
      matchingClusterIndexes.push(index);
    }
  }

  if (matchingClusterIndexes.length === 0) {
    clusters.push(new Set([leftIndex, rightIndex]));
    return;
  }

  const [targetIndex, ...mergeIndexes] = matchingClusterIndexes;
  const targetCluster = clusters[targetIndex];
  targetCluster.add(leftIndex);
  targetCluster.add(rightIndex);

  for (const mergeIndex of mergeIndexes.sort((a, b) => b - a)) {
    for (const marketIndex of clusters[mergeIndex]) {
      targetCluster.add(marketIndex);
    }
    clusters.splice(mergeIndex, 1);
  }
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------
interface ActiveMarket {
  tmId: string;
  questionId: string | null;
  questionText: string | null;
  timeframe: string;
  granularTimeframe: string | null;
  category: string;
  topicKey: string | null;
  topicLabel: string | null;
  affiliatedOrgIds: string[] | null;
  affiliatedActorIds: string[] | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const db = getRawDrizzle();

  // 1. Query active markets joined with questions
  const activeRows: ActiveMarket[] = await db
    .select({
      tmId: timeframedMarkets.id,
      questionId: timeframedMarkets.questionId,
      questionText: questions.text,
      timeframe: timeframedMarkets.timeframe,
      granularTimeframe: timeframedMarkets.granularTimeframe,
      category: timeframedMarkets.category,
      topicKey: timeframedMarkets.topicKey,
      topicLabel: timeframedMarkets.topicLabel,
      affiliatedOrgIds: timeframedMarkets.affiliatedOrgIds,
      affiliatedActorIds: timeframedMarkets.affiliatedActorIds,
    })
    .from(timeframedMarkets)
    .leftJoin(questions, eq(timeframedMarkets.questionId, questions.id))
    .where(
      and(
        eq(timeframedMarkets.isActive, true),
        eq(timeframedMarkets.isResolved, false),
      ),
    );

  // Build org name lookup for entity reporting
  const orgRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations);
  const orgNameMap = new Map(orgRows.map((o) => [o.id, o.name]));

  const total = activeRows.length;

  console.log(`\n=== MARKET DIVERSITY REPORT ===`);
  console.log(`Active Markets: ${total}\n`);

  if (total === 0) {
    console.log("No active markets found. Nothing to report.");
    return;
  }

  // Token sets for each market
  const tokenSets = activeRows.map((m) => tokenize(m.questionText ?? ""));

  // ----- Topic Analysis -----
  const similarities: number[] = [];
  const duplicates: { i: number; j: number; score: number }[] = [];
  const clusters: Set<number>[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < total; i++) {
    for (let j = i + 1; j < total; j++) {
      const score = jaccard(tokenSets[i], tokenSets[j]);
      similarities.push(score);
      if (score > 0.5) duplicates.push({ i, j, score });
      if (score > 0.3) {
        addPairToClusters(clusters, i, j);
        assigned.add(i);
        assigned.add(j);
      }
    }
  }
  // Each unassigned market is its own cluster
  for (let i = 0; i < total; i++) {
    if (!assigned.has(i)) clusters.push(new Set([i]));
  }

  const avgSim =
    similarities.length > 0
      ? similarities.reduce((a, b) => a + b, 0) / similarities.length
      : 0;
  const largestCluster = clusters.reduce((max, c) => Math.max(max, c.size), 0);
  const largestClusterIdx = clusters.findIndex(
    (c) => c.size === largestCluster,
  );
  const largestClusterSample =
    largestClusterIdx >= 0
      ? (activeRows[[...clusters[largestClusterIdx]][0]]?.questionText?.slice(
          0,
          60,
        ) ?? "unknown")
      : "";

  console.log("Topic Analysis:");
  console.log(`  Unique topic clusters: ${clusters.length}`);
  const simLabel =
    avgSim >= 0.2
      ? crit(`${avgSim.toFixed(2)}  !! HIGH (target: <0.2)`)
      : ok(`${avgSim.toFixed(2)}`);
  console.log(`  Avg pairwise similarity: ${simLabel}`);
  console.log(
    `  Largest cluster: ${largestCluster} markets about "${largestClusterSample}"`,
  );
  console.log();

  // ----- Entity Frequency -----
  const orgCounts = new Map<string, number>();
  const actorCounts = new Map<string, number>();
  for (const m of activeRows) {
    for (const orgId of m.affiliatedOrgIds ?? []) {
      const label = orgNameMap.get(orgId) ?? orgId;
      orgCounts.set(label, (orgCounts.get(label) ?? 0) + 1);
    }
    for (const actorId of m.affiliatedActorIds ?? []) {
      actorCounts.set(actorId, (actorCounts.get(actorId) ?? 0) + 1);
    }
  }

  const topEntities = [
    ...Array.from(orgCounts.entries()).map(([name, count]) => ({
      name,
      count,
      type: "org" as const,
    })),
    ...Array.from(actorCounts.entries()).map(([name, count]) => ({
      name,
      count,
      type: "actor" as const,
    })),
  ]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  console.log("Entity Frequency:");
  if (topEntities.length === 0) {
    console.log("  (no affiliated entities found)");
  }
  for (const e of topEntities) {
    const pct = Math.round((e.count / total) * 100);
    const flag =
      pct > 50 ? crit(`!! OVER-REPRESENTED`) : pct > 40 ? warn(`! high`) : "";
    console.log(
      `  ${e.name.padEnd(20)} ${e.count}/${total} markets (${pct}%) ${flag}`,
    );
  }
  console.log();

  // ----- Timeframe Balance -----
  const tfCounts = new Map<string, number>();
  for (const m of activeRows) {
    const key = m.granularTimeframe ?? m.timeframe;
    tfCounts.set(key, (tfCounts.get(key) ?? 0) + 1);
  }

  console.log("Timeframe Balance:");
  const tfParts: string[] = [];
  for (const [tf, expected] of Object.entries(MARKET_STRUCTURE)) {
    const actual = tfCounts.get(tf) ?? 0;
    const status =
      actual === expected
        ? ok(`${actual} OK`)
        : actual < expected
          ? crit(`${actual}/${expected} !! GAP`)
          : warn(`${actual}/${expected} ! OVER`);
    tfParts.push(`  ${tf}: ${status}`);
  }
  console.log(tfParts.join("\n"));
  console.log();

  // ----- Category Distribution -----
  const catCounts = new Map<string, number>();
  for (const m of activeRows) {
    catCounts.set(m.category, (catCounts.get(m.category) ?? 0) + 1);
  }

  console.log("Category Distribution:");
  const sortedCats = Array.from(catCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [cat, count] of sortedCats) {
    const pct = Math.round((count / total) * 100);
    const flag = pct > 60 ? crit(`!! DOMINANT`) : "";
    console.log(`  ${cat}: ${count} (${pct}%) ${flag}`);
  }
  console.log();

  // ----- Daily Topic Concentration -----
  const topicCounts = new Map<string, number>();
  for (const m of activeRows) {
    if (m.topicKey) {
      topicCounts.set(m.topicKey, (topicCounts.get(m.topicKey) ?? 0) + 1);
    }
  }

  console.log("Daily Topic Concentration:");
  if (topicCounts.size === 0) {
    console.log("  (no topic keys assigned)");
  }
  const sortedTopics = Array.from(topicCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [topic, count] of sortedTopics) {
    const pct = Math.round((count / total) * 100);
    const flag = pct > 70 ? crit(`!! MONO-TOPIC`) : "";
    console.log(`  "${topic}": ${count}/${total} (${pct}%) ${flag}`);
  }
  console.log();

  // ----- Near-Duplicate Detection -----
  console.log("Near-Duplicates:");
  if (duplicates.length === 0) {
    console.log(`  ${ok("None detected")}`);
  }
  for (const d of duplicates.sort((a, b) => b.score - a.score)) {
    console.log(`  Q${d.i} <-> Q${d.j}: Jaccard ${warn(d.score.toFixed(2))}`);
    if (verbose) {
      console.log(`    "${activeRows[d.i].questionText}"`);
      console.log(`    "${activeRows[d.j].questionText}"`);
    } else {
      const t1 = activeRows[d.i].questionText?.slice(0, 70) ?? "";
      const t2 = activeRows[d.j].questionText?.slice(0, 70) ?? "";
      console.log(`    "${t1}"`);
      console.log(`    "${t2}"`);
    }
  }

  // ----- History trend (if requested) -----
  if (historyDays > 0) {
    const since = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);
    const resolved = await db
      .select({
        id: timeframedMarkets.id,
        category: timeframedMarkets.category,
        topicKey: timeframedMarkets.topicKey,
        resolvedAt: timeframedMarkets.resolvedAt,
      })
      .from(timeframedMarkets)
      .where(
        and(
          eq(timeframedMarkets.isResolved, true),
          gte(timeframedMarkets.resolvedAt, since),
        ),
      );

    console.log(
      `\nHistory (last ${historyDays} days): ${resolved.length} resolved markets`,
    );
    const histCats = new Map<string, number>();
    for (const r of resolved) {
      histCats.set(r.category, (histCats.get(r.category) ?? 0) + 1);
    }
    for (const [cat, count] of Array.from(histCats.entries()).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${cat}: ${count}`);
    }
  }

  console.log(`\n${ok("Report complete.")}\n`);
}

main()
  .catch((err) => {
    console.error(crit("Report failed:"), err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
