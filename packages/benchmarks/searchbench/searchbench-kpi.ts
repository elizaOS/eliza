/**
 * Measuring harness for chat message search at scale (#13534, follow-up #9955).
 *
 * Seeds a deterministic ≥10,000-message corpus into a REAL PGlite store (the
 * same `@elizaos/plugin-sql` adapter + migrations that install the
 * `eliza_message_search_document` FTS + `pg_trgm` GIN indexes production uses),
 * then runs a labeled gold set of edge-case queries through the real
 * `IDatabaseAdapter.searchMessages` and measures retrieval quality
 * (precision@10 / recall@10 / MRR / nDCG@10) and query latency (p50/p95/max),
 * plus index build time. No metric is fabricated: a value is `measured:true`
 * only when a real query produced it; the whole run exits non-zero when a
 * measured budget regresses, so CI gates on it directly.
 *
 * Run under bun so the real @elizaos/plugin-sql PGlite path resolves:
 *   bun --conditions=eliza-source packages/benchmarks/searchbench/searchbench-kpi.ts
 * `run-all.mjs` is the orchestrator that spawns this and writes the dashboard.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
// Import the plugin-sql adapter + FTS migration objects from the repo's own
// source tree (this file benchmarks the current checkout). A relative path
// pins the measured code to this tree; the bare `@elizaos/plugin-sql` specifier
// can resolve to an installed copy in a shared-node_modules worktree.
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  memoryTable,
  plugin as sqlPlugin,
} from "../../../plugins/plugin-sql/src/index.node.ts";
import { loadBudgets, quantile, recordResult, round } from "./lib.mjs";
import { ndcgAtK } from "./metric-schema.mjs";

const CORPUS_SIZE = Number(process.env.SEARCHBENCH_CORPUS ?? 10_000);
const LATENCY_REPEATS = Number(process.env.SEARCHBENCH_LATENCY_REPEATS ?? 5);
const NOW = new Date().toISOString();

/** Deterministic xorshift PRNG so corpus + placement are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

interface GoldCase {
  id: string;
  kind: string;
  query: string;
  /** The exact message texts (and optional attachment) planted as relevant. */
  relevant: Array<{
    text: string;
    attachment?: { title?: string; url?: string };
  }>;
  /** Force placement of the first relevant row at the oldest corpus index. */
  oldestFirst?: boolean;
}

// Each gold case uses a rare, unique token so filler noise can never
// accidentally satisfy it — recall/precision then isolate the search behaviour,
// not lexical luck. Tokens end in the corpus-reserved 'q' suffix that filler
// never emits.
const GOLD: GoldCase[] = [
  {
    id: "multiword-nonadjacent",
    kind: "multiword",
    query: "deployq agentq",
    relevant: [
      { text: "please deployq the very first agentq to the cloud now" },
      { text: "deployq your production agentq before the demo" },
    ],
  },
  {
    id: "partial-word-trigram",
    kind: "partial",
    query: "zephyrconfig",
    relevant: [
      { text: "the zephyrconfiguration file needs an edit" },
      { text: "reload the zephyrconfiguration after saving" },
    ],
  },
  {
    id: "accent-fold",
    kind: "accent",
    query: "cafeq",
    relevant: [{ text: "the caféq downtown roasts its own beans" }],
  },
  {
    id: "quoted-phrase",
    kind: "phrase",
    query: '"alphaq betaq"',
    relevant: [{ text: "the alphaq betaq gammaq sequence is stable" }],
    // A non-adjacent distractor that a bare-OR query would wrongly rank in.
  },
  {
    id: "url-substring",
    kind: "url",
    query: "exampleq.com/pathq",
    relevant: [
      { text: "open https://exampleq.com/pathq/to/thing for the writeup" },
    ],
  },
  {
    id: "emoji",
    kind: "emoji",
    query: "🛰️queryemoji",
    relevant: [{ text: "launch status 🛰️queryemoji nominal today" }],
  },
  {
    id: "cjk",
    kind: "cjk",
    query: "北京q",
    relevant: [{ text: "会议在 北京q 举行" }],
  },
  {
    id: "attachment-filename",
    kind: "attachment",
    query: "reportq-2026",
    relevant: [
      {
        text: "here is the document you requested",
        attachment: {
          title: "reportq-2026-final.pdf",
          url: "https://cdn.example.com/reportq-2026-final.pdf",
        },
      },
    ],
  },
  {
    id: "near-duplicate",
    kind: "duplicate",
    query: "dupqmarker",
    relevant: [
      { text: "dupqmarker identical body" },
      { text: "dupqmarker identical body" },
      { text: "dupqmarker identical body" },
    ],
  },
  {
    id: "older-than-window",
    kind: "older-hit",
    query: "xyzzyneedleq",
    relevant: [{ text: "the oldest message carries the xyzzyneedleq token" }],
    oldestFirst: true,
  },
];

interface SeededRow {
  text: string;
  attachment?: { title?: string; url?: string };
  goldId?: string;
}

/** Build the full corpus: gold-relevant rows scattered into deterministic filler. */
function buildCorpus(): {
  rows: SeededRow[];
  relevantIndexByGold: Map<string, number[]>;
} {
  const rng = makeRng(0xc0ffee);
  const rows: SeededRow[] = new Array(CORPUS_SIZE);
  const relevantIndexByGold = new Map<string, number[]>();

  const goldRows: SeededRow[] = [];
  let oldestGold: SeededRow | undefined;
  for (const g of GOLD) {
    relevantIndexByGold.set(g.id, []);
    g.relevant.forEach((r, i) => {
      const row: SeededRow = {
        text: r.text,
        attachment: r.attachment,
        goldId: g.id,
      };
      if (g.oldestFirst && i === 0) oldestGold = row;
      else goldRows.push(row);
    });
  }

  // Fill with deterministic filler that never contains a gold token.
  for (let i = 0; i < CORPUS_SIZE; i++) {
    rows[i] = { text: `filler chatter ${i} ordinary words variant ${i % 11}` };
  }
  // The oldest-hit relevant row is pinned at index 0 (oldest timestamp).
  let cursor = 0;
  if (oldestGold) {
    rows[0] = oldestGold;
    relevantIndexByGold.get(oldestGold.goldId as string)?.push(0);
    cursor = 1;
  }
  // Scatter the remaining gold rows across deterministic positions in the tail.
  for (const row of goldRows) {
    let idx = cursor + Math.floor(rng() * (CORPUS_SIZE - cursor));
    while (rows[idx].goldId)
      idx = cursor + Math.floor(rng() * (CORPUS_SIZE - cursor));
    rows[idx] = row;
    relevantIndexByGold.get(row.goldId as string)?.push(idx);
  }
  return { rows, relevantIndexByGold };
}

async function main(): Promise<number> {
  const budgets = loadBudgets();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "searchbench-"));
  const agentId = v4() as UUID;
  const worldId = v4() as UUID;
  const entityId = v4() as UUID;
  const roomId = v4() as UUID;

  let adapter: IDatabaseAdapter | undefined;
  try {
    adapter = createDatabaseAdapter({ dataDir }, agentId);
    await adapter.init();
    const db = (
      adapter as unknown as { getDatabase: () => never }
    ).getDatabase();

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations();

    await adapter.createAgent({
      id: agentId,
      name: "searchbench",
      bio: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    await adapter.createWorld({
      id: worldId,
      agentId,
      name: "W",
      serverId: "searchbench",
    } as never);
    await adapter.createEntities([
      { id: entityId, agentId, names: ["seed"] } as never,
    ]);
    await adapter.createRooms([
      {
        id: roomId,
        agentId,
        worldId,
        name: "r",
        source: "bench",
        type: "DM",
      } as never,
    ]);
    await adapter.addParticipant(entityId, roomId);

    const { rows, relevantIndexByGold } = buildCorpus();
    const base = Date.now() - CORPUS_SIZE * 1000;
    const insertStart = Date.now();
    const CHUNK = 2000;
    let batch: Array<Record<string, unknown>> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const content: Record<string, unknown> = { text: r.text };
      if (r.attachment) content.attachments = [r.attachment];
      batch.push({
        id: v4() as UUID,
        type: "messages",
        content,
        entityId,
        agentId,
        roomId,
        worldId,
        unique: false,
        metadata: { type: "messages" },
        createdAt: new Date(base + i * 1000),
      });
      if (batch.length >= CHUNK) {
        await db.insert(memoryTable).values(batch as never);
        batch = [];
      }
    }
    if (batch.length) await db.insert(memoryTable).values(batch as never);
    const insertMs = Date.now() - insertStart;

    // Rebuild the FTS GIN index on the full corpus to measure index build time
    // (the incremental per-insert maintenance is not a representative number).
    const reindexStart = Date.now();
    await db.execute(sql`REINDEX INDEX idx_memories_message_fts`);
    const indexBuildMs = Date.now() - reindexStart;

    // Confirm the corpus actually landed — a short corpus invalidates the run.
    const countRows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM memories WHERE type = 'messages'`,
    )) as unknown as { rows?: Array<{ n: number }> };
    const corpusSize =
      countRows.rows?.[0]?.n ??
      (Array.isArray(countRows) ? (countRows[0] as { n: number }).n : 0);

    // Which latency budget applies: with pg_trgm the substring/partial fallback
    // is a trigram-GIN index scan (fast, production/cloud); without it the
    // fallback scans the STORED document column (slower, this PGlite build).
    const trigramRows = (await db.execute(
      sql`SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm'`,
    )) as unknown as { rows?: unknown[] };
    const trigramAvailable = Array.isArray(trigramRows.rows)
      ? trigramRows.rows.length > 0
      : Array.isArray(trigramRows) && trigramRows.length > 0;

    // Warm the plan cache once so first-query JIT/parse cost is excluded.
    await adapter.searchMessages({
      roomIds: [roomId],
      query: "warmup",
      limit: 10,
    });

    const goldResults: Array<Record<string, unknown>> = [];
    const allLatencies: number[] = [];
    for (const g of GOLD) {
      const relevantIdxs = relevantIndexByGold.get(g.id) ?? [];
      const relevantTexts = new Set(g.relevant.map((r) => r.text));
      let last: Awaited<ReturnType<IDatabaseAdapter["searchMessages"]>> = [];
      for (let rep = 0; rep < LATENCY_REPEATS; rep++) {
        const t0 = performance.now();
        last = await adapter.searchMessages({
          roomIds: [roomId],
          query: g.query,
          limit: 20,
        });
        const dt = performance.now() - t0;
        allLatencies.push(dt);
      }
      const returnedTexts = last.map(
        (h) => (h.memory.content as { text?: string }).text ?? "",
      );
      const top10Flags = returnedTexts
        .slice(0, 10)
        .map((t) => relevantTexts.has(t));
      const hitsAt10 = top10Flags.filter(Boolean).length;
      const relevant = relevantIdxs.length;
      const firstRank = returnedTexts.findIndex((t) => relevantTexts.has(t));
      goldResults.push({
        id: g.id,
        query: g.query,
        kind: g.kind,
        relevant,
        returned: last.length,
        hitsAt10,
        recallAt10: relevant === 0 ? null : round(hitsAt10 / relevant),
        precisionAt10:
          last.length === 0 ? 0 : round(hitsAt10 / Math.min(10, last.length)),
        reciprocalRank: firstRank < 0 ? 0 : round(1 / (firstRank + 1)),
        ndcgAt10: round(ndcgAtK(top10Flags, 10)),
        latencyMs: round(allLatencies[allLatencies.length - 1], 3),
      });
    }

    const measuredGold = goldResults.filter((r) => r.relevant !== 0);
    const mean = (key: string) =>
      measuredGold.length === 0
        ? null
        : round(
            measuredGold.reduce((a, r) => a + (r[key] as number), 0) /
              measuredGold.length,
          );
    const aggregate = {
      corpusSize,
      trigramAvailable,
      insertMs,
      indexBuildMs,
      precisionAt10: mean("precisionAt10"),
      recallAt10: mean("recallAt10"),
      mrr: mean("reciprocalRank"),
      ndcgAt10: mean("ndcgAt10"),
      p50LatencyMs: round(quantile(allLatencies, 0.5), 3),
      p95LatencyMs: round(quantile(allLatencies, 0.95), 3),
      maxLatencyMs: round(Math.max(...allLatencies), 3),
      latencySamples: allLatencies.length,
    };

    const b = budgets.budgets;
    const p95Budget = trigramAvailable
      ? b.maxP95LatencyMsTrigram
      : b.maxP95LatencyMsNoTrigram;
    const checks = [
      {
        name: "corpusSize",
        value: aggregate.corpusSize,
        budget: b.minCorpus,
        cmp: "min",
      },
      {
        name: "recallAt10",
        value: aggregate.recallAt10,
        budget: b.minRecallAt10,
        cmp: "min",
      },
      {
        name: "precisionAt10",
        value: aggregate.precisionAt10,
        budget: b.minPrecisionAt10,
        cmp: "min",
      },
      { name: "mrr", value: aggregate.mrr, budget: b.minMrr, cmp: "min" },
      {
        name: "ndcgAt10",
        value: aggregate.ndcgAt10,
        budget: b.minNdcgAt10,
        cmp: "min",
      },
      {
        name: trigramAvailable
          ? "p95LatencyMs (trigram)"
          : "p95LatencyMs (no-trigram)",
        value: aggregate.p95LatencyMs,
        budget: p95Budget,
        cmp: "max",
      },
      {
        name: "indexBuildMs",
        value: aggregate.indexBuildMs,
        budget: b.maxIndexBuildMs,
        cmp: "max",
      },
    ].map((c) => ({
      ...c,
      pass:
        c.value == null
          ? false
          : c.cmp === "min"
            ? c.value >= c.budget
            : c.value <= c.budget,
    }));

    const measured = corpusSize >= (budgets.budgets.minCorpus ?? 10_000);
    const allPass = measured && checks.every((c) => c.pass);
    recordResult(
      "searchbench",
      {
        measured,
        summary: { corpus: corpusSize, gold: GOLD.length, ...aggregate },
        aggregate,
        gold: goldResults,
        checks,
      },
      NOW,
    );

    for (const c of checks) {
      const cmp = c.cmp === "min" ? "≥" : "≤";
      console.log(
        `[searchbench] ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.value} ${cmp} ${c.budget}`,
      );
    }
    return allPass ? 0 : 1;
  } catch (err) {
    // error-policy:J1 harness boundary — a genuine environment failure (PGlite
    // unavailable, import failure) exits 2 (nothing measurable), never a false
    // green. A budget regression is the exit-1 path above.
    console.error(
      `[searchbench] harness failed to measure: ${err instanceof Error ? err.stack : String(err)}`,
    );
    recordResult("searchbench", { measured: false, error: String(err) }, NOW);
    return 2;
  } finally {
    try {
      await (adapter as unknown as { close?: () => Promise<void> })?.close?.();
    } catch {
      // error-policy:J6 best-effort teardown of the scratch PGlite store.
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));
