/**
 * recall-bench runner (#9956) — drives the REAL `@elizaos/core` recall path over
 * a labelled, document-scale corpus and reports per-`SearchMode` IR quality +
 * latency, the fail-open degradation, and the keyword chat-search baseline.
 *
 * Run:  bun --conditions=eliza-source run.ts [--tier smoke|1k|10k] [--out DIR]
 *
 * Emits `<out>/recall-bench-results.json` (the orchestrator + the budget gate
 * both read it) and exits per the memperf contract: 0 = budgets pass, 1 = a
 * budget regression, 2 = nothing measurable.
 *
 * Honesty contract (memperf): a mode is `measured:true` only when a real run
 * produced its numbers; unmeasured metrics are `null`, never `0`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankByKeyword } from "@elizaos/agent/api";
import {
  bm25Scores,
  type Memory,
  normalizeBm25Scores,
  type State,
  type UUID,
} from "@elizaos/core";
// The FACTS provider is internal to @elizaos/core (not on the public barrel);
// a benchmark legitimately reaches into the same source tree to drive the real
// keyword-recall path it measures. Resolved via the eliza-source condition.
import { factsProvider } from "../../core/src/features/advanced-capabilities/providers/facts.ts";
import budgets from "./budgets.json" with { type: "json" };
import {
  buildCorpus,
  buildFacts,
  buildMorphologyCorpus,
  type Corpus,
  type CorpusTier,
} from "./corpus.ts";
import { embedText } from "./embedding.ts";
import {
  type QueryResult,
  type RecallSummary,
  summarizeRecall,
} from "./metrics.ts";
import { type BenchRuntime, buildBenchRuntime } from "./runtime.ts";

// The bench is a pure retrieval-quality measurement — trajectory writes are just
// noise (and a stray state dir). Disable them before the runtime initializes, so
// a credential-free orchestrator invocation needs no env wrapper.
process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING ??= "1";

const K = 5;
const FRAGMENTS_TABLE = "document_fragments";

interface ModeReport extends RecallSummary {
  mode: string;
  corpusSize: number;
  skipReason?: string;
}

interface BudgetCheck {
  name: string;
  pass: boolean;
  value: number | null;
  budget: number;
  unit: string;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { tier: CorpusTier; out: string } {
  let tier: CorpusTier = "smoke";
  let out = join(import.meta.dirname, "results");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tier") tier = argv[++i] as CorpusTier;
    else if (argv[i] === "--out") out = argv[++i];
  }
  return { tier, out };
}

const uuid = () => crypto.randomUUID() as UUID;

// ── helpers ───────────────────────────────────────────────────────────────────

/** Resolve a search hit (StoredDocument fragment) back to its corpus doc id. */
function hitDocId(
  hit: { id: UUID; metadata?: { documentId?: string } },
  docIdByMemId: Map<string, string>,
): string | undefined {
  const memId = hit.metadata?.documentId;
  return memId ? docIdByMemId.get(memId) : docIdByMemId.get(hit.id);
}

/** Unique corpus doc ids in rank order from a list of fragment hits. */
function rankedDocIds(
  hits: Array<{ id: UUID; metadata?: { documentId?: string } }>,
  docIdByMemId: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    const docId = hitDocId(hit, docIdByMemId);
    if (docId && !seen.has(docId)) {
      seen.add(docId);
      out.push(docId);
    }
  }
  return out;
}

function makeMessage(bench: BenchRuntime, text: string): Memory {
  return {
    id: uuid(),
    entityId: bench.agentId,
    agentId: bench.agentId,
    roomId: bench.agentId,
    content: { text },
    createdAt: Date.now(),
  };
}

// ── per-mode runners (drive the REAL code) ────────────────────────────────────

/** DocumentService.searchDocuments in one of the three SearchModes. */
async function runDocumentMode(
  bench: BenchRuntime,
  corpus: Corpus,
  docIdByMemId: Map<string, string>,
  mode: "hybrid" | "vector" | "keyword",
  label: string,
): Promise<ModeReport> {
  const results: QueryResult[] = [];
  const latencies: number[] = [];
  for (const q of corpus.queries) {
    const message = makeMessage(bench, q.text);
    const t0 = performance.now();
    const hits = await bench.documents.searchDocuments(
      message,
      { roomId: bench.agentId },
      mode,
    );
    latencies.push(performance.now() - t0);
    results.push({
      retrieved: rankedDocIds(hits, docIdByMemId),
      relevant: new Set(q.relevantDocIds),
    });
  }
  return {
    mode: label,
    corpusSize: corpus.docs.length,
    ...summarizeRecall(results, K, latencies),
  };
}

/** runtime.searchMemories directly over document_fragments (pure vector recall,
 *  no `query` rerank — measures the adapter's cosine path the providers ride). */
async function runSearchMemories(
  bench: BenchRuntime,
  corpus: Corpus,
  docIdByMemId: Map<string, string>,
): Promise<ModeReport> {
  const results: QueryResult[] = [];
  const latencies: number[] = [];
  for (const q of corpus.queries) {
    const embedding = embedText(q.text);
    const t0 = performance.now();
    const mems = await bench.runtime.searchMemories({
      tableName: FRAGMENTS_TABLE,
      embedding,
      roomId: bench.agentId,
      limit: 20,
    });
    latencies.push(performance.now() - t0);
    results.push({
      retrieved: rankedDocIds(
        mems as Array<{ id: UUID; metadata?: { documentId?: string } }>,
        docIdByMemId,
      ),
      relevant: new Set(q.relevantDocIds),
    });
  }
  return {
    mode: "searchMemories-vector",
    corpusSize: corpus.docs.length,
    ...summarizeRecall(results, K, latencies),
  };
}

/** The keyword chat-search ranker (`rankByKeyword`, BM25) over the same corpus. */
async function runKeywordChat(
  bench: BenchRuntime,
  corpus: Corpus,
  docIdByMemId: Map<string, string>,
): Promise<ModeReport> {
  const fragments = (await bench.runtime.getMemories({
    tableName: FRAGMENTS_TABLE,
    roomId: bench.agentId,
    count: corpus.docs.length * 4,
  })) as Array<{
    id: UUID;
    content: { text?: string };
    metadata?: { documentId?: string };
  }>;
  const results: QueryResult[] = [];
  const latencies: number[] = [];
  for (const q of corpus.queries) {
    const t0 = performance.now();
    const ranked = rankByKeyword(q.text, fragments, (m) => m.content.text ?? "")
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
    latencies.push(performance.now() - t0);
    results.push({
      retrieved: rankedDocIds(ranked, docIdByMemId),
      relevant: new Set(q.relevantDocIds),
    });
  }
  return {
    mode: "keyword-chat-bm25",
    corpusSize: corpus.docs.length,
    ...summarizeRecall(results, K, latencies),
  };
}

/** The FACTS provider: keyword + recency recall over the `facts` table (no
 *  vectors). Ingests labelled facts (one per query + distractors) and measures
 *  whether `factsProvider.get` surfaces the right fact among the distractors. */
async function runFactsProvider(
  bench: BenchRuntime,
  corpus: Corpus,
): Promise<ModeReport> {
  const facts = buildFacts(corpus.tier as CorpusTier);
  // Insert facts as `facts`-table memories. id is tracked → query mapping.
  const relevantByQuery = new Map<string, Set<string>>();
  for (const fact of facts) {
    const factMemId = uuid();
    await bench.runtime.createMemory(
      {
        id: factMemId,
        entityId: bench.agentId,
        agentId: bench.agentId,
        roomId: bench.agentId,
        content: { text: fact.text },
        metadata: {
          kind: fact.kind,
          category: "identity",
          confidence: 0.9,
          keywords: fact.keywords,
        },
        createdAt: Date.now(),
      } as Memory,
      "facts",
    );
    if (fact.relevantQueryId) {
      const set = relevantByQuery.get(fact.relevantQueryId) ?? new Set();
      set.add(factMemId);
      relevantByQuery.set(fact.relevantQueryId, set);
    }
  }

  const emptyState: State = { values: {}, data: {}, text: "" };
  const results: QueryResult[] = [];
  const latencies: number[] = [];
  for (const q of corpus.queries) {
    const message = makeMessage(bench, q.text);
    const t0 = performance.now();
    const res = await factsProvider.get(bench.runtime, message, emptyState);
    latencies.push(performance.now() - t0);
    const ranked = (res.data?.facts ?? []) as Array<{ id: UUID }>;
    results.push({
      retrieved: ranked.map((f) => f.id as string),
      relevant: relevantByQuery.get(q.id) ?? new Set<string>(),
    });
  }
  return {
    mode: "facts-provider-keyword",
    corpusSize: facts.length,
    ...summarizeRecall(results, K, latencies),
  };
}

/** Morphology slice (keyword-only, no runtime needed): proves Porter2 stemming
 *  lifts keyword recall. Ranks the morphology corpus with the REAL production
 *  ranker (`rankByKeyword`, stemmed) vs an unstemmed BM25 baseline (the documents
 *  `bm25Scores`) — the recall LIFT is attributable purely to stemming, since each
 *  query's `-ing` form is absent from every doc but shares its Porter stem. */
function runMorphology(): {
  stemmed: ModeReport;
  unstemmed: ModeReport;
  lift: number;
} {
  const corpus = buildMorphologyCorpus();
  const docs = corpus.docs.map((d) => ({ id: d.id, text: d.text }));
  const stemmedResults: QueryResult[] = [];
  const unstemmedResults: QueryResult[] = [];
  const stemLat: number[] = [];
  const unstemLat: number[] = [];
  for (const q of corpus.queries) {
    const relevant = new Set(q.relevantDocIds);
    let t0 = performance.now();
    const stemRanked = rankByKeyword(q.text, corpus.docs, (d) => d.text)
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item.id);
    stemLat.push(performance.now() - t0);
    stemmedResults.push({ retrieved: stemRanked, relevant });

    t0 = performance.now();
    const unstemRanked = normalizeBm25Scores(bm25Scores(q.text, docs))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.id);
    unstemLat.push(performance.now() - t0);
    unstemmedResults.push({ retrieved: unstemRanked, relevant });
  }
  const stemmed: ModeReport = {
    mode: "keyword-morph-stemmed",
    corpusSize: corpus.docs.length,
    ...summarizeRecall(stemmedResults, K, stemLat),
  };
  const unstemmed: ModeReport = {
    mode: "keyword-morph-unstemmed",
    corpusSize: corpus.docs.length,
    ...summarizeRecall(unstemmedResults, K, unstemLat),
  };
  return {
    stemmed,
    unstemmed,
    lift: (stemmed.recallAtK ?? 0) - (unstemmed.recallAtK ?? 0),
  };
}

// ── budget gate ───────────────────────────────────────────────────────────────

function checkBudgets(modes: ModeReport[]): BudgetCheck[] {
  const checks: BudgetCheck[] = [];
  const byMode = new Map(modes.map((m) => [m.mode, m]));
  for (const [modeName, rules] of Object.entries(budgets.modes)) {
    const report = byMode.get(modeName);
    if (!report?.measured) continue; // skipped rows never fail a budget
    const r = rules as {
      minRecallAt5?: number;
      minNdcgAt5?: number;
      maxP95LatencyMs?: number;
    };
    if (r.minRecallAt5 !== undefined) {
      checks.push({
        name: `${modeName}.minRecallAt5`,
        value: report.recallAtK,
        budget: r.minRecallAt5,
        unit: "ratio",
        pass: (report.recallAtK ?? 0) >= r.minRecallAt5,
      });
    }
    if (r.minNdcgAt5 !== undefined) {
      checks.push({
        name: `${modeName}.minNdcgAt5`,
        value: report.ndcgAtK,
        budget: r.minNdcgAt5,
        unit: "ratio",
        pass: (report.ndcgAtK ?? 0) >= r.minNdcgAt5,
      });
    }
    if (r.maxP95LatencyMs !== undefined) {
      checks.push({
        name: `${modeName}.maxP95LatencyMs`,
        value: report.p95LatencyMs,
        budget: r.maxP95LatencyMs,
        unit: "ms",
        pass: (report.p95LatencyMs ?? 0) <= r.maxP95LatencyMs,
      });
    }
  }
  return checks;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { tier, out } = parseArgs(process.argv.slice(2));
  const corpus = buildCorpus(tier);
  const bench = await buildBenchRuntime();

  // Ingest the labelled corpus through the REAL DocumentService.
  const docIdByMemId = new Map<string, string>();
  for (const doc of corpus.docs) {
    const res = await bench.documents.addDocument({
      worldId: bench.agentId,
      roomId: bench.agentId,
      entityId: bench.agentId,
      clientDocumentId: uuid(),
      contentType: "text/plain",
      originalFilename: `${doc.id}.txt`,
      // addDocument expects base64-encoded file bytes for text documents (the
      // service base64-decodes them); encode so the heuristic decodes cleanly.
      content: Buffer.from(doc.text, "utf8").toString("base64"),
    });
    docIdByMemId.set(res.storedDocumentMemoryId, doc.id);
  }

  const hybrid = await runDocumentMode(
    bench,
    corpus,
    docIdByMemId,
    "hybrid",
    "document-hybrid",
  );
  const vector = await runDocumentMode(
    bench,
    corpus,
    docIdByMemId,
    "vector",
    "document-vector",
  );
  const keyword = await runDocumentMode(
    bench,
    corpus,
    docIdByMemId,
    "keyword",
    "document-keyword",
  );
  const searchMem = await runSearchMemories(bench, corpus, docIdByMemId);
  const keywordChat = await runKeywordChat(bench, corpus, docIdByMemId);
  const factsProv = await runFactsProvider(bench, corpus);
  // Keyword-only, runtime-independent: stemmed (production) vs unstemmed BM25.
  const morph = runMorphology();

  // Fail-open: make the QUERY embedder throw → embedRecallQuery returns null →
  // _vectorSearch falls open to keyword. Re-run the vector mode and measure the
  // recall drop — the silent degradation #9956 asks us to make observable.
  // Mint a fresh run id first: embedRecallQuery memoizes successful query
  // embeddings per-run-id, so without this the throw would be masked by the
  // vectors cached during the healthy `document-vector` slice above.
  bench.runtime.startRun();
  bench.setEmbedMode("throw");
  const failOpen = await runDocumentMode(
    bench,
    corpus,
    docIdByMemId,
    "vector",
    "document-vector-failopen",
  );
  bench.setEmbedMode("ok");

  await bench.cleanup();

  const modes: ModeReport[] = [
    hybrid,
    vector,
    keyword,
    searchMem,
    keywordChat,
    factsProv,
    morph.stemmed,
    morph.unstemmed,
    failOpen,
  ];
  const checks = checkBudgets(modes);

  const failOpenDrop = (vector.recallAtK ?? 0) - (failOpen.recallAtK ?? 0);
  const failOpenObservable =
    failOpenDrop >= budgets.failOpen.minObservableRecallDrop;
  checks.push({
    name: "failOpen.minObservableRecallDrop",
    value: failOpenDrop,
    budget: budgets.failOpen.minObservableRecallDrop,
    unit: "ratio",
    pass: failOpenObservable,
  });

  const stemmingObservable = morph.lift >= budgets.stemming.minRecallLift;
  checks.push({
    name: "stemming.minRecallLift",
    value: morph.lift,
    budget: budgets.stemming.minRecallLift,
    unit: "ratio",
    pass: stemmingObservable,
  });

  const report = {
    benchmark: "recall-bench",
    generatedAt: new Date().toISOString(),
    corpus: {
      committed: true,
      tier: corpus.tier,
      topics: corpus.topics,
      documents: corpus.docs.length,
      queries: corpus.queries.length,
    },
    k: K,
    modes,
    failOpen: {
      vectorRecallAt5: vector.recallAtK,
      failOpenRecallAt5: failOpen.recallAtK,
      recallDrop: failOpenDrop,
      observable: failOpenObservable,
    },
    stemming: {
      stemmedRecallAt5: morph.stemmed.recallAtK,
      unstemmedRecallAt5: morph.unstemmed.recallAtK,
      recallLift: morph.lift,
      observable: stemmingObservable,
    },
    // The single score the orchestrator extracts — hybrid is production default.
    metrics: {
      overall_recall_at_5: hybrid.recallAtK,
      overall_ndcg_at_5: hybrid.ndcgAtK,
      overall_p95_latency_ms: hybrid.p95LatencyMs,
    },
    checks,
  };

  mkdirSync(out, { recursive: true });
  const outFile = join(out, "recall-bench-results.json");
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  const measuredCount = modes.filter((m) => m.measured).length;
  const pass = checks.every((c) => c.pass);
  for (const m of modes) {
    console.log(
      `[recall-bench] ${m.mode}: recall@5=${fmt(m.recallAtK)} ndcg@5=${fmt(m.ndcgAtK)} p95=${fmt(m.p95LatencyMs)}ms (${m.measured ? "measured" : `skip: ${m.skipReason}`})`,
    );
  }
  console.log(
    `[recall-bench] fail-open recall drop ${fmt(failOpenDrop)} (observable=${failOpenObservable})`,
  );
  console.log(
    `[recall-bench] stemming recall lift ${fmt(morph.lift)} (observable=${stemmingObservable})`,
  );
  console.log(`[recall-bench] → ${outFile}`);
  console.log(
    `[recall-bench] budgets ${pass ? "PASS" : "FAIL"} (${checks.filter((c) => c.pass).length}/${checks.length})`,
  );

  if (measuredCount === 0) return 2;
  return pass ? 0 : 1;
}

function fmt(n: number | null): string {
  return n === null ? "null" : n.toFixed(3);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[recall-bench] fatal:", err);
    process.exit(1);
  });
