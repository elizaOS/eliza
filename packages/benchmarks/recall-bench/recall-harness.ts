/**
 * recall-bench harness (#9956).
 *
 * Boots a REAL `@elizaos/core` AgentRuntime + real `@elizaos/plugin-sql`
 * (PGlite, in-process) + the real `documentsPlugin`, registers a deterministic
 * content-hash TEXT_EMBEDDING model (the real model layer — the runtime
 * dispatches to it exactly like a cloud model), ingests a templated corpus
 * through the real `DocumentService.addDocument` ingestion path, and then drives
 * every recall surface:
 *
 *   - DocumentService.searchDocuments(mode) for hybrid / vector / keyword
 *   - the low-level runtime.searchMemories + embedRecallQuery path
 *   - the scoreMemoryText keyword chat-search surface
 *
 * Labels are resolved via Option A: the fixture labels by docKey; this harness
 * builds Map<`${documentId}:${position}` -> fragmentUUID> from the live
 * document_fragments rows and expands each query's relevant docKeys to the live
 * fragment UUIDs of those documents. No fragment UUID is ever hard-coded.
 *
 * The embedding is deterministic + content-dependent + key-free, so the bench
 * is reproducible and runs with no API keys. A `failOnQueryEmbed` mode makes the
 * live query embed throw (the null dimension-probe still returns a valid zero
 * vector) so `embedRecallQuery` fails open to keyword — the real fail-open path.
 */

import { createHash } from "node:crypto";

import {
	AgentRuntime,
	ChannelType,
	createUniqueUuid,
	type Content,
	type DocumentService as DocumentServiceType,
	documentsPlugin,
	embedRecallQuery,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type Plugin,
	type UUID,
} from "@elizaos/core";

// scoreMemoryText is the real shipped chat-search scorer. Import the module file
// directly (the ./api/* subpath, eliza-source -> ./src/api/memory-routes.ts) to
// avoid pulling the heavy/side-effectful agent api barrel.
import { scoreMemoryText } from "@elizaos/agent/api/memory-routes";

import { CONCEPT_IDS, detectConcepts } from "./concept-lexicon.ts";
import type { CorpusFile, CorpusQuery, QueriesFile } from "./corpus-gen.ts";

export const EMBED_DIM = 384;

// The first CONCEPT_DIMS dimensions are reserved concept anchors (one per
// concept id); the remaining dimensions carry a token-hash signal. The concept
// anchor is weighted far above the lexical token signal so two texts that share
// a CONCEPT (e.g. the canonical term "rubisco" and its synonym phrase "carbon
// capture enzyme") land close in cosine space even with zero token overlap —
// the semantic-but-non-lexical recall a real embedding provides. The token-hash
// tail keeps the embedding content-dependent (no two distinct texts collide).
const CONCEPT_DIMS = CONCEPT_IDS.length;
// Concepts are the dominant semantic signal; the token-hash tail is a light
// lexical tie-breaker. The concept anchor weight is set well above the per-token
// tail magnitude so two texts sharing a concept (canonical vs. synonym surface)
// are close in cosine space even with zero token overlap.
const CONCEPT_WEIGHT = 3.0;
const TOKEN_WEIGHT = 0.35;
const CONCEPT_INDEX = new Map(CONCEPT_IDS.map((id, i) => [id, i]));

/**
 * Hash a token to a sparse set of (dimension, sign) entries in the token tail.
 * Each token activates a few tail dimensions with ±1 — a signed feature-hashing
 * (hashing-trick) embedding, so distinct tokens are near-orthogonal and a
 * token's contribution does not systematically bias the whole tail.
 */
function hashTokenToTail(token: string, tailStart: number, tailLen: number, vec: number[]): void {
	if (tailLen <= 0) return;
	const h = createHash("sha256").update(token).digest();
	// 4 signed activations per token, drawn from disjoint hash byte windows.
	for (let j = 0; j < 4; j++) {
		const dim = ((h[j * 2] << 8) | h[j * 2 + 1]) % tailLen;
		const sign = h[j * 2 + 1] & 1 ? 1 : -1;
		vec[tailStart + dim] += TOKEN_WEIGHT * sign;
	}
}

/** Deterministic concept-aware embedding for a piece of text. */
export function embedText(text: string): number[] {
	const vec = new Array(EMBED_DIM).fill(0);
	// Concept anchors (the dominant semantic signal). Each concept fires once,
	// regardless of how many times its surface phrase appears.
	for (const conceptId of new Set(detectConcepts(text))) {
		const idx = CONCEPT_INDEX.get(conceptId);
		if (idx != null && idx < CONCEPT_DIMS) vec[idx] += CONCEPT_WEIGHT;
	}
	// Token-hash tail (light lexical tie-breaker).
	const tailStart = CONCEPT_DIMS;
	const tailLen = EMBED_DIM - tailStart;
	const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
	for (const tok of tokens) hashTokenToTail(tok, tailStart, tailLen, vec);

	let sumSq = 0;
	for (const v of vec) sumSq += v * v;
	const norm = Math.sqrt(sumSq) || 1;
	for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
	return vec;
}

/**
 * A mutable switch the embedding model reads on every call. When `failing` is
 * true, a real {text} embed THROWS so `embedRecallQuery` fails open to keyword.
 * It is a runtime toggle (not a boot-time flag) so the corpus can be ingested
 * with a HEALTHY embedding and only the QUERY-time embeds forced to throw —
 * otherwise ingestion (which also embeds via the same model) would fail and
 * leave the corpus unstored, making even the keyword baseline empty.
 */
export interface EmbedFailSwitch {
	failing: boolean;
}

/**
 * Deterministic, content-dependent, concept-aware embedding registered as a
 * REAL TEXT_EMBEDDING model handler. This IS the real recall path — the runtime
 * dispatches to it exactly like a cloud model.
 *   - params == null (dimension probe at ensureEmbeddingDimension): return a
 *     valid zero vector of length EMBED_DIM so initialize() succeeds.
 *   - failSwitch.failing: throw on a real {text} embed so embedRecallQuery fails
 *     open to keyword (the real fail-open regression seam) — but STILL return
 *     the zero vector for the null probe so boot succeeds.
 *   - otherwise: an L2-normalized concept-anchor + token-hash embedding so
 *     cosine ordering is meaningful, semantic, and reproducible.
 */
export function makeHashEmbeddingPlugin(failSwitch: EmbedFailSwitch): Plugin {
	return {
		name: "recall-bench-hash-embedding",
		description:
			"Deterministic concept-aware TEXT_EMBEDDING for recall benchmarking (#9956)",
		priority: 1000, // beat any other embedding model that may register
		models: {
			[ModelType.TEXT_EMBEDDING]: async (
				_rt: IAgentRuntime,
				params: { text?: string } | string | null,
			): Promise<number[]> => {
				if (params == null) return new Array(EMBED_DIM).fill(0);
				const text =
					typeof params === "string" ? params : (params.text ?? "");
				if (text.trim().length === 0) return new Array(EMBED_DIM).fill(0);
				if (failSwitch.failing) {
					throw new Error(
						"recall-bench: forced embed failure (fail-open regression)",
					);
				}
				return embedText(text);
			},
		},
	};
}

export interface BootedHarness {
	runtime: AgentRuntime;
	docs: DocumentServiceType;
	worldId: UUID;
	roomId: UUID;
	entityId: UUID;
	/** Live toggle the embedding reads: set `.failing = true` to force fail-open. */
	failSwitch: EmbedFailSwitch;
	cleanup(): Promise<void>;
}

/**
 * Boot the inline runtime per the verified recipe: construct AgentRuntime with
 * an empty plugin list, register plugin-sql, register the embedding plugin +
 * documentsPlugin (embedding model BEFORE initialize so ensureEmbeddingDimension
 * probes it), then initialize().
 *
 * `failSwitch` (default healthy) is the live toggle the embedding reads — set
 * `boot.failSwitch.failing = true` AFTER ingestion to force the fail-open path
 * for query-time embeds only.
 */
export async function bootHarness(opts?: {
	logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}): Promise<BootedHarness> {
	// Each boot gets its OWN fresh PGlite database in a unique temp dir so runs
	// never share state (plugin-sql resolves PGLITE_DATA_DIR from the env and
	// from runtime settings; the on-disk default `.eliza/.elizadb` would persist
	// fragments across runs and pollute recall metrics). A unique dir + closing
	// the manager on cleanup also defeats the process-global manager singleton.
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join: pathJoin } = await import("node:path");
	const dbDir = mkdtempSync(pathJoin(tmpdir(), "recall-bench-pglite-"));
	process.env.PGLITE_DATA_DIR = dbDir;

	// EMBEDDING_PROVIDER=local makes DocumentService.start()'s validateModelConfig
	// short-circuit (config.ts:124-126) so it never demands OPENAI_API_KEY.
	const settings: Record<string, string> = {
		EMBEDDING_PROVIDER: "local",
		LOAD_DOCS_ON_STARTUP: "false",
		CTX_DOCUMENTS_ENABLED: "false",
		PGLITE_DATA_DIR: dbDir,
	};

	const runtime = new AgentRuntime({
		character: {
			name: "RecallBench",
			bio: ["A deterministic recall-benchmark agent."],
		},
		plugins: [],
		settings,
		logLevel: opts?.logLevel ?? "warn",
	});

	const failSwitch: EmbedFailSwitch = { failing: false };
	const pluginSql = (await import("@elizaos/plugin-sql")).default;
	await runtime.registerPlugin(pluginSql);
	// Embedding model BEFORE initialize() — ensureEmbeddingDimension probes it.
	await runtime.registerPlugin(makeHashEmbeddingPlugin(failSwitch));
	await runtime.registerPlugin(documentsPlugin);
	await runtime.initialize();

	// Service start is lazy/async; getService() may be null right after
	// initialize(). getServiceLoadPromise() ensures it has started (mirrors the
	// agent-side documents-service-loader fallback).
	let docs = runtime.getService("documents") as unknown as DocumentServiceType;
	if (!docs) {
		docs = (await runtime.getServiceLoadPromise(
			"documents",
		)) as unknown as DocumentServiceType;
	}
	if (!docs) throw new Error("recall-bench: DocumentService not registered");

	const worldId = createUniqueUuid(runtime, "recall-bench-world") as UUID;
	const roomId = createUniqueUuid(runtime, "recall-bench-room") as UUID;
	const entityId = runtime.agentId;

	// Create the world + room so the document_fragments rows (scoped to
	// roomId/worldId) satisfy the FK constraints. The agent entity already
	// exists after initialize().
	await runtime.ensureWorldExists({
		id: worldId,
		name: "recall-bench-world",
		agentId: runtime.agentId,
	});
	await runtime.ensureRoomExists({
		id: roomId,
		name: "recall-bench-room",
		source: "recall-bench",
		type: ChannelType.GROUP,
		worldId,
	});

	return {
		runtime,
		docs,
		worldId,
		roomId,
		entityId,
		failSwitch,
		cleanup: async () => {
			try {
				await runtime.stop?.();
			} catch {
				/* best-effort */
			}
			// Close + clear the process-global PGlite manager singleton so the next
			// boot in this process creates a FRESH in-memory database rather than
			// reusing this (now-deleted) one. Without this, plugin-sql's
			// `shouldReusePgliteManager` keeps handing back the dead manager.
			try {
				const GLOBAL = Symbol.for("elizaos.plugin-sql.global-singletons");
				const singletons = (
					globalThis as typeof globalThis & Record<symbol, unknown>
				)[GLOBAL] as
					| { pgLiteClientManager?: { close?: () => Promise<void> } }
					| undefined;
				const mgr = singletons?.pgLiteClientManager;
				if (mgr?.close) await mgr.close();
				if (singletons) singletons.pgLiteClientManager = undefined;
			} catch {
				/* best-effort */
			}
			try {
				rmSync(dbDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

/** Ingest the corpus through the REAL DocumentService.addDocument path. */
export async function ingestCorpus(
	boot: Awaited<ReturnType<typeof bootHarness>>,
	corpus: CorpusFile,
): Promise<{
	docIdByKey: Map<string, UUID>;
	fragmentIdsByDocKey: Map<string, UUID[]>;
	fragmentCount: number;
}> {
	const { runtime, docs, worldId, roomId, entityId } = boot;
	const docIdByKey = new Map<string, UUID>();
	let fragmentCount = 0;

	for (const d of corpus.documents) {
		const res = await docs.addDocument({
			worldId,
			roomId,
			entityId,
			clientDocumentId: createUniqueUuid(runtime, d.docKey) as UUID,
			contentType: d.contentType,
			originalFilename: d.filename,
			content: d.content,
			scope: "global",
			addedFrom: "runtime-internal",
		});
		// addDocument recomputes the document id from a content hash.
		docIdByKey.set(d.docKey, res.storedDocumentMemoryId);
		fragmentCount += res.fragmentCount;
	}

	// Option A label resolution: read live fragments, build documentId -> [fragUUID].
	const allFragments = await runtime.getMemories({
		tableName: "document_fragments",
		agentId: runtime.agentId,
		roomId,
		worldId,
		count: 100000,
	});
	const fragmentIdsByDocId = new Map<string, UUID[]>();
	for (const frag of allFragments) {
		const meta = frag.metadata as { documentId?: UUID; position?: number } | undefined;
		const documentId = meta?.documentId;
		if (!documentId || !frag.id) continue;
		const arr = fragmentIdsByDocId.get(documentId) ?? [];
		arr.push(frag.id as UUID);
		fragmentIdsByDocId.set(documentId, arr);
	}
	const fragmentIdsByDocKey = new Map<string, UUID[]>();
	for (const [docKey, docId] of docIdByKey) {
		fragmentIdsByDocKey.set(docKey, fragmentIdsByDocId.get(docId) ?? []);
	}

	return { docIdByKey, fragmentIdsByDocKey, fragmentCount };
}

/** Build the live relevant fragment-UUID set for a query (Option A resolution). */
export function relevantFragmentIds(
	query: CorpusQuery,
	fragmentIdsByDocKey: Map<string, UUID[]>,
): Set<string> {
	const set = new Set<string>();
	for (const docKey of query.relevantDocKeys) {
		for (const fid of fragmentIdsByDocKey.get(docKey) ?? []) set.add(fid);
	}
	return set;
}

function makeQueryMemory(
	runtime: IAgentRuntime,
	queryId: string,
	text: string,
	roomId: UUID,
	worldId: UUID,
	entityId: UUID,
): Memory {
	return {
		id: createUniqueUuid(runtime, `q-${queryId}`) as UUID,
		agentId: runtime.agentId,
		entityId,
		roomId,
		worldId,
		content: { text } as Content,
		createdAt: Date.now(),
	};
}

export interface ModeRun {
	/** Per-query ranked result fragment ids (best-first). */
	results: { queryId: string; resultIds: string[] }[];
	/** Per-query retrieval latency (ms). */
	latenciesMs: number[];
}

/**
 * Run a DocumentService.searchDocuments mode over the query set.
 * resultIds are the live fragment UUIDs (StoredDocument.id).
 */
export async function runSearchMode(
	boot: Awaited<ReturnType<typeof bootHarness>>,
	queries: QueriesFile,
	mode: "hybrid" | "vector" | "keyword",
): Promise<ModeRun> {
	const { runtime, docs, roomId, worldId, entityId } = boot;
	const results: { queryId: string; resultIds: string[] }[] = [];
	const latenciesMs: number[] = [];
	for (const q of queries.queries) {
		const msg = makeQueryMemory(
			runtime,
			q.queryId,
			q.queryText,
			roomId,
			worldId,
			entityId,
		);
		const t0 = performance.now();
		const hits = await docs.searchDocuments(msg, { roomId, worldId }, mode);
		latenciesMs.push(performance.now() - t0);
		results.push({
			queryId: q.queryId,
			resultIds: hits.map((h) => h.id as string),
		});
	}
	return { results, latenciesMs };
}

/**
 * Run the low-level PURE-vector runtime path: embedRecallQuery →
 * runtime.searchMemories over document_fragments WITHOUT a `query` argument, so
 * the runtime returns the raw cosine ranking and does NOT apply its in-process
 * BM25 rerank. This isolates the embedding's semantic recall (the rerank, which
 * DocumentService._vectorSearch/_hybridSearch trigger by passing `query`, drops
 * any candidate with no lexical overlap — so it caps pure-semantic recall). The
 * contrast between this row and the `vector`/`hybrid` rows quantifies how much
 * the internal rerank suppresses non-lexical recall.
 */
export async function runRuntimeVector(
	boot: Awaited<ReturnType<typeof bootHarness>>,
	queries: QueriesFile,
): Promise<ModeRun> {
	const { runtime, roomId, worldId } = boot;
	const results: { queryId: string; resultIds: string[] }[] = [];
	const latenciesMs: number[] = [];
	for (const q of queries.queries) {
		const t0 = performance.now();
		const embedding = await embedRecallQuery(runtime, q.queryText);
		let resultIds: string[] = [];
		if (embedding) {
			const mems = await runtime.searchMemories({
				tableName: "document_fragments",
				embedding,
				// NB: no `query` → no BM25 rerank → raw cosine order.
				roomId,
				worldId,
				limit: 20,
				match_threshold: 0.1,
			});
			resultIds = mems.map((m) => m.id as string).filter(Boolean);
		}
		latenciesMs.push(performance.now() - t0);
		results.push({ queryId: q.queryId, resultIds });
	}
	return { results, latenciesMs };
}

/**
 * Run the scoreMemoryText keyword chat-search surface over the corpus fragments.
 * This is the real shipped scorer from packages/agent/src/api/memory-routes.ts.
 */
export async function runKeywordChatSearch(
	boot: Awaited<ReturnType<typeof bootHarness>>,
	queries: QueriesFile,
): Promise<ModeRun> {
	const { runtime, roomId, worldId } = boot;
	const allFragments = await runtime.getMemories({
		tableName: "document_fragments",
		agentId: runtime.agentId,
		roomId,
		worldId,
		count: 100000,
	});
	const results: { queryId: string; resultIds: string[] }[] = [];
	const latenciesMs: number[] = [];
	for (const q of queries.queries) {
		const t0 = performance.now();
		const scored = allFragments
			.map((m) => ({
				id: m.id as string,
				score: scoreMemoryText(m.content.text ?? "", q.queryText),
			}))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 20);
		latenciesMs.push(performance.now() - t0);
		results.push({ queryId: q.queryId, resultIds: scored.map((s) => s.id) });
	}
	return { results, latenciesMs };
}
