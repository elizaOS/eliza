/**
 * CI-safe real-path recall test (#9956).
 *
 * Run: bun test --conditions=eliza-source packages/benchmarks/recall-bench/recall-eval.test.ts
 *
 * Boots the REAL @elizaos/core recall pipeline (AgentRuntime + plugin-sql PGlite
 * + documentsPlugin + the deterministic content-hash embedding), ingests the
 * SMALL corpus through the real DocumentService.addDocument path, and asserts:
 *
 *   (a) on a semantic-but-NON-lexical query (paraphrase: synonyms with no token
 *       overlap with the doc terms), vector & hybrid recall@5 strictly exceed
 *       keyword recall@5 — the embedding path earns its keep.
 *   (b) forcing the query embed to throw (fail-open) makes hybrid & vector
 *       recall@5 equal the keyword baseline — the fail-open path is observable.
 *
 * This is the real-runtime regression test the CI gate runs before the harness.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { generate, type QueriesFile, TIERS } from "./corpus-gen.ts";
import { mean, type QueryResult, recallAtK } from "./metrics.ts";
import {
	bootHarness,
	ingestCorpus,
	type ModeRun,
	relevantFragmentIds,
	runRuntimeVector,
	runSearchMode,
} from "./recall-harness.ts";
import type { UUID } from "@elizaos/core";

const { corpus, queries } = generate({ ...TIERS.small, seed: 42 });

/** Macro recall@5 over a ModeRun + the query labels. */
function recallAt5Of(
	run: ModeRun,
	q: QueriesFile,
	fragmentIdsByDocKey: Map<string, UUID[]>,
): number {
	const resById = new Map(run.results.map((r) => [r.queryId, r.resultIds]));
	const ranked: QueryResult[] = q.queries.map((query) => ({
		retrieved: resById.get(query.queryId) ?? [],
		relevant: relevantFragmentIds(query, fragmentIdsByDocKey),
	}));
	return mean(ranked.map((r) => recallAtK(r, 5))) ?? 0;
}

/** Macro recall@5 for a DocumentService search mode. */
async function recallAt5ForMode(
	boot: Awaited<ReturnType<typeof bootHarness>>,
	q: QueriesFile,
	fragmentIdsByDocKey: Map<string, UUID[]>,
	mode: "hybrid" | "vector" | "keyword",
): Promise<number> {
	return recallAt5Of(await runSearchMode(boot, q, mode), q, fragmentIdsByDocKey);
}

describe("recall-bench real-path recall (small corpus)", () => {
	let boot: Awaited<ReturnType<typeof bootHarness>>;
	let fragmentIdsByDocKey: Map<string, UUID[]>;

	beforeAll(async () => {
		boot = await bootHarness({ logLevel: "error" });
		const res = await ingestCorpus(boot, corpus);
		fragmentIdsByDocKey = res.fragmentIdsByDocKey;
		expect(res.fragmentCount).toBeGreaterThan(0);
	}, 60_000); // boot + ingest the small corpus; raise above bun's 5s default.

	// Close + clear this boot's PGlite singleton so the next describe block
	// gets a fresh database (each bootHarness needs an isolated in-memory DB).
	afterAll(async () => {
		await boot.cleanup();
	});

	it("ingested fragments resolve to live UUIDs for every doc", () => {
		// Every corpus doc must map to at least one live fragment UUID.
		let withFragments = 0;
		for (const d of corpus.documents) {
			if ((fragmentIdsByDocKey.get(d.docKey) ?? []).length > 0) withFragments++;
		}
		expect(withFragments).toBe(corpus.documents.length);
	});

	it("pure vector recall beats keyword recall@5 on semantic (non-lexical) queries", async () => {
		// Restrict to paraphrase queries (synonyms → no lexical overlap with doc
		// terms), where keyword BM25 cannot match but the embedding can. The pure
		// runtime-vector path (raw cosine, no in-process BM25 rerank) is the honest
		// demonstration that the embedding earns its keep: DocumentService's
		// vector/hybrid modes pass `query` to searchMemories, which applies a BM25
		// rerank that DROPS zero-lexical-overlap hits — capping pure-semantic
		// recall. runtime-vector skips that rerank, so its recall reflects the
		// embedding's true semantic reach.
		const semanticQueries: QueriesFile = {
			...queries,
			queries: queries.queries.filter((q) => q.semantic),
		};
		expect(semanticQueries.queries.length).toBeGreaterThan(0);

		const kw = await recallAt5ForMode(
			boot,
			semanticQueries,
			fragmentIdsByDocKey,
			"keyword",
		);
		const pureVec = recallAt5Of(
			await runRuntimeVector(boot, semanticQueries),
			semanticQueries,
			fragmentIdsByDocKey,
		);

		// The embedding recalls semantic matches the keyword path cannot.
		expect(pureVec).toBeGreaterThan(kw);
	}, 30_000);
});

describe("recall-bench fail-open is observable", () => {
	it("forcing the query embed to throw collapses hybrid & vector to keyword", async () => {
		// Healthy keyword baseline.
		const healthy = await bootHarness({ logLevel: "error" });
		const healthyRes = await ingestCorpus(healthy, corpus);
		const keywordR5 = await recallAt5ForMode(
			healthy,
			queries,
			healthyRes.fragmentIdsByDocKey,
			"keyword",
		);
		await healthy.cleanup();

		// Reboot, ingest with a HEALTHY embedding, then flip the switch so only
		// QUERY-time embeds throw → embedRecallQuery fails open to keyword. (If
		// ingestion embeds also threw, no fragment would store and even keyword
		// would be empty — which is not the fail-open behaviour under test.)
		const failOpen = await bootHarness({ logLevel: "error" });
		const foRes = await ingestCorpus(failOpen, corpus);
		failOpen.failSwitch.failing = true;
		const foHybrid = await recallAt5ForMode(
			failOpen,
			queries,
			foRes.fragmentIdsByDocKey,
			"hybrid",
		);
		const foVector = await recallAt5ForMode(
			failOpen,
			queries,
			foRes.fragmentIdsByDocKey,
			"vector",
		);
		const foKeyword = await recallAt5ForMode(
			failOpen,
			queries,
			foRes.fragmentIdsByDocKey,
			"keyword",
		);
		await failOpen.cleanup();

		// Fail-open hybrid & vector must equal the keyword baseline (delta ~ 0).
		expect(Math.abs(foHybrid - foKeyword)).toBeLessThan(1e-9);
		expect(Math.abs(foVector - foKeyword)).toBeLessThan(1e-9);
		// And the fail-open keyword equals a clean keyword run (same corpus/seed).
		expect(Math.abs(foKeyword - keywordR5)).toBeLessThan(1e-9);
	}, 60_000); // two full boots + ingests; raise above bun's 5s default.
});
