/**
 * Deterministic templated-topic corpus + query generator for recall-bench (#9956).
 *
 * Mirrors the relevance-by-construction pattern used by
 * `packages/benchmarks/experience/.../generator.py`: a query's ground truth is
 * the *topic cluster it was generated from* — no human labelling, correctness
 * is guaranteed generatively. The generator is seeded (default 42) and pure, so
 * regeneration is byte-identical across runs/machines.
 *
 * Output (per map §3c):
 *   - corpus: { topics[], documents[{ docKey, topicId, filename, contentType,
 *               content }] } — each document templated from its topic's
 *               distinctive vocabulary so a query built from a topic's terms is
 *               relevant to (and only to) that topic's documents.
 *   - queries: { kValues[], queries[{ queryId, topicId, queryType, queryText,
 *               relevantDocKeys[] }] } — ground truth = topic cluster membership.
 *
 * Label resolution to live fragment UUIDs (Option A) happens in the harness:
 * the fixture labels by docKey; the harness joins docKey → live documentId and
 * expands to that document's fragment UUIDs at ingest time.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) — pure, seedable, no deps.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Rng {
	next(): number;
	int(maxExclusive: number): number;
	pick<T>(arr: readonly T[]): T;
	sample<T>(arr: readonly T[], count: number): T[];
	shuffle<T>(arr: T[]): T[];
}

function makeRng(seed: number): Rng {
	const r = mulberry32(seed);
	const int = (maxExclusive: number) => Math.floor(r() * maxExclusive);
	return {
		next: r,
		int,
		pick: <T>(arr: readonly T[]) => arr[int(arr.length)],
		sample: <T>(arr: readonly T[], count: number) => {
			const copy = [...arr];
			// Fisher-Yates partial shuffle.
			for (let i = 0; i < Math.min(count, copy.length); i++) {
				const j = i + int(copy.length - i);
				[copy[i], copy[j]] = [copy[j], copy[i]];
			}
			return copy.slice(0, Math.min(count, copy.length));
		},
		shuffle: <T>(arr: T[]) => {
			for (let i = arr.length - 1; i > 0; i--) {
				const j = int(i + 1);
				[arr[i], arr[j]] = [arr[j], arr[i]];
			}
			return arr;
		},
	};
}

// ---------------------------------------------------------------------------
// Topic vocabularies are sourced from the shared concept lexicon so the corpus,
// the queries, and the embedding model all agree on which surface phrases map
// to which concept. A topic's distinctive CANONICAL terms anchor its documents;
// the matching SYNONYM phrases (no token overlap) drive the paraphrase queries
// the concept-aware embedding can still resolve.
// ---------------------------------------------------------------------------
import { type Concept, TOPIC_DEFS } from "./concept-lexicon.ts";

interface Topic {
	id: string;
	domain: string;
	/** Distinctive canonical terms unique to this topic. */
	terms: string[];
	/** Synonyms for paraphrase queries: canonical term -> non-lexical synonym phrase. */
	synonyms: Record<string, string>;
	/** The topic's concepts (each can be a document's primary cluster anchor). */
	concepts: Concept[];
}

const TOPICS: Topic[] = TOPIC_DEFS.map((t) => ({
	id: t.id,
	domain: t.domain,
	terms: t.concepts.map((c) => c.canonical),
	synonyms: Object.fromEntries(
		t.concepts.map((c) => [c.canonical, c.synonym]),
	),
	concepts: t.concepts,
}));

const FILLER = [
	"This document explains the topic in practical terms.",
	"Engineers and practitioners reference this material frequently.",
	"The following notes summarize the key considerations.",
	"Understanding these concepts is essential for the field.",
	"The section below covers the relevant details and trade-offs.",
	"Several factors interact and must be balanced carefully.",
];

export interface CorpusDocument {
	docKey: string;
	topicId: string;
	/** The concept this document is centered on (its relevant-cluster key). */
	conceptId: string;
	filename: string;
	contentType: string;
	content: string;
}

export interface CorpusFile {
	$schema: "recall-bench-corpus/v1";
	seed: number;
	tier: string;
	embeddingDim: number;
	topics: { id: string; domain: string }[];
	documents: CorpusDocument[];
}

export type QueryType = "exact" | "paraphrase" | "partial" | "cross-domain";

export interface CorpusQuery {
	queryId: string;
	topicId: string;
	/** The concept id this query targets (the ground-truth cluster key). */
	conceptId: string;
	queryType: QueryType;
	queryText: string;
	/** docKeys whose primaryConcept == this query's conceptId (the relevant cluster). */
	relevantDocKeys: string[];
	/** Whether this query is semantic-but-non-lexical (paraphrase) — used by the eval test. */
	semantic: boolean;
}

export interface QueriesFile {
	$schema: "recall-bench-queries/v1";
	seed: number;
	tier: string;
	kValues: number[];
	queries: CorpusQuery[];
}

export interface GenOptions {
	seed?: number;
	tier?: string;
	/**
	 * Documents to generate per concept (the relevant-cluster size). Keep small
	 * (≈5-8) so recall@5 is meaningful — a query's relevant set is exactly this
	 * many docs.
	 */
	docsPerConcept: number;
	/**
	 * Off-concept DISTRACTOR documents (relevant to NO query) added to inflate
	 * the corpus to a realistic "needle in haystack" size without growing any
	 * relevant cluster. Use this to hit the ≥1k-fragment standard tier.
	 */
	distractorCount: number;
	/** Total queries to generate. */
	queryCount: number;
	embeddingDim?: number;
}

const K_VALUES = [1, 3, 5, 10];

// A flat list of every (topic, concept) so documents/queries cluster on a
// single CONCEPT, not a whole topic. This keeps the relevant-set size small and
// bounded (≈ docsPerConcept) so recall@k stays meaningful at 1k+ fragments —
// unlike topic-wide clusters, where the relevant set grows with the corpus and
// caps recall@k mechanically.
const FLAT_CONCEPTS = TOPICS.flatMap((t) =>
	t.concepts.map((c) => ({ topic: t, concept: c })),
);

/** Build a templated document body centered on ONE concept (its primary). */
function buildConceptDocument(
	topic: Topic,
	concept: { canonical: string; synonym: string },
	rng: Rng,
	index: number,
): string {
	const sentences: string[] = [];
	sentences.push(
		`Topic overview: ${topic.id.replace(/-/g, " ")} in the domain of ${topic.domain}.`,
	);
	// Anchor the document on its primary concept's canonical term (repeated for
	// lexical weight), so a query about this concept matches THIS doc cluster.
	sentences.push(
		`The ${concept.canonical} is the central concept here; understanding the ${concept.canonical} is essential, and managing the ${concept.canonical} affects overall behavior.`,
	);
	// Mention one OTHER topic concept lightly for realism (not the primary).
	const other = rng.pick(topic.terms);
	if (other !== concept.canonical) {
		sentences.push(`It also relates to the ${other}.`);
	}
	const fillerCount = 2 + rng.int(3);
	for (let i = 0; i < fillerCount; i++) sentences.push(rng.pick(FILLER));
	sentences.push(
		`Document ${index} elaborates the ${concept.canonical} further within ${topic.id}.`,
	);
	return sentences.join(" ");
}

/** Generate the corpus + queries deterministically. */
export function generate(opts: GenOptions): {
	corpus: CorpusFile;
	queries: QueriesFile;
} {
	const seed = opts.seed ?? 42;
	const tier = opts.tier ?? "standard";
	const embeddingDim = opts.embeddingDim ?? 384;
	const rng = makeRng(seed);

	// docsPerConcept relevant docs per concept (the small relevant cluster).
	const docsPerConcept = Math.max(2, opts.docsPerConcept);
	const documents: CorpusDocument[] = [];
	const docKeysByConcept = new Map<string, string[]>();
	let docNum = 0;
	for (const { topic, concept } of FLAT_CONCEPTS) {
		const keys: string[] = [];
		for (let i = 0; i < docsPerConcept; i++) {
			docNum++;
			const docKey = `doc-${String(docNum).padStart(5, "0")}`;
			keys.push(docKey);
			documents.push({
				docKey,
				topicId: topic.id,
				conceptId: concept.id,
				filename: `${concept.id}-${String(i).padStart(3, "0")}.txt`,
				contentType: "text/plain",
				content: buildConceptDocument(topic, concept, rng, docNum),
			});
		}
		docKeysByConcept.set(concept.id, keys);
	}

	// Off-concept distractor documents (relevant to NO query) to inflate the
	// corpus to a realistic haystack. Each uses generic filler-only content with
	// no concept term, so it can never be a relevant hit — it only adds noise.
	for (let i = 0; i < opts.distractorCount; i++) {
		docNum++;
		const docKey = `doc-${String(docNum).padStart(5, "0")}`;
		const fillerCount = 4 + rng.int(4);
		const body = [`Distractor note ${docNum}.`];
		for (let j = 0; j < fillerCount; j++) body.push(rng.pick(FILLER));
		documents.push({
			docKey,
			topicId: "_distractor",
			conceptId: "_distractor",
			filename: `distractor-${String(docNum).padStart(5, "0")}.txt`,
			contentType: "text/plain",
			content: body.join(" "),
		});
	}

	// Query mix (per generator.py allocations): 40% exact, 30% paraphrase,
	// 20% partial, 10% cross-domain distractor. Each query targets ONE concept.
	const queries: CorpusQuery[] = [];
	const typeFor = (i: number): QueryType => {
		const r = i % 10;
		if (r < 4) return "exact";
		if (r < 7) return "paraphrase";
		if (r < 9) return "partial";
		return "cross-domain";
	};

	for (let i = 0; i < opts.queryCount; i++) {
		const { topic, concept } = FLAT_CONCEPTS[i % FLAT_CONCEPTS.length];
		const qType = typeFor(i);
		const relevantDocKeys = docKeysByConcept.get(concept.id) ?? [];
		let queryText: string;
		let semantic = false;

		if (qType === "exact") {
			// Canonical term verbatim → strong lexical overlap with the cluster docs.
			queryText = `what about the ${concept.canonical} in ${topic.domain}`;
		} else if (qType === "paraphrase") {
			// SYNONYM phrase (no lexical overlap with the canonical term) → the
			// concept-aware embedding can still resolve it; BM25 cannot.
			queryText = `explain the ${concept.synonym}`;
			semantic = true;
		} else if (qType === "partial") {
			// Canonical term + generic filler.
			queryText = `how to best handle the ${concept.canonical} in practice`;
		} else {
			// cross-domain distractor: the concept's term mixed with an unrelated
			// concept term; still labelled to its own concept cluster.
			const other = rng.pick(TOPICS.filter((t) => t.id !== topic.id));
			queryText = `${concept.canonical} compared with ${rng.pick(other.terms)} considerations`;
		}

		queries.push({
			queryId: `q-${String(i + 1).padStart(5, "0")}`,
			topicId: topic.id,
			conceptId: concept.id,
			queryType: qType,
			queryText,
			relevantDocKeys,
			semantic,
		});
	}

	return {
		corpus: {
			$schema: "recall-bench-corpus/v1",
			seed,
			tier,
			embeddingDim,
			topics: TOPICS.map((t) => ({ id: t.id, domain: t.domain })),
			documents,
		},
		queries: {
			$schema: "recall-bench-queries/v1",
			seed,
			tier,
			kValues: K_VALUES,
			queries,
		},
	};
}

/** Tier presets. small = CI self-check / unit test; standard targets ≥1k fragments. */
export const TIERS: Record<string, GenOptions> = {
	// 40 concepts × 4 relevant docs = 160 concept docs + 0 distractors. Short
	// plain-text docs ≈ 1 fragment each → ~160 fragments. Relevant-cluster size 4
	// keeps recall@5 meaningful. Fast CI-safe self-check.
	small: { tier: "small", docsPerConcept: 4, distractorCount: 0, queryCount: 80 },
	// ≥1000 fragments: 40 concepts × 6 relevant docs = 240 concept docs + 800
	// off-concept distractors = 1040 docs ≈ 1040 fragments. Relevant-cluster size
	// 6 keeps recall@5 meaningful while the distractors make a realistic haystack.
	standard: {
		tier: "standard",
		docsPerConcept: 6,
		distractorCount: 800,
		queryCount: 200,
	},
};

// CLI: emit a fixture to stdout or to a file.
//   bun packages/benchmarks/recall-bench/corpus-gen.ts --tier small
//   bun packages/benchmarks/recall-bench/corpus-gen.ts --tier standard --out fixtures/
if (import.meta.main) {
	const argv = process.argv.slice(2);
	const get = (flag: string, def?: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
	};
	const tier = get("--tier", "small") as string;
	const seed = Number(get("--seed", "42"));
	const preset = TIERS[tier];
	if (!preset) {
		console.error(`unknown tier: ${tier} (expected one of ${Object.keys(TIERS).join(", ")})`);
		process.exit(2);
	}
	const { corpus, queries } = generate({ ...preset, seed });
	const out = get("--out");
	if (out) {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		mkdirSync(out, { recursive: true });
		writeFileSync(
			join(out, `corpus.${tier}.json`),
			`${JSON.stringify(corpus, null, 2)}\n`,
		);
		writeFileSync(
			join(out, `queries.${tier}.json`),
			`${JSON.stringify(queries, null, 2)}\n`,
		);
		console.log(
			`[corpus-gen] tier=${tier} seed=${seed} docs=${corpus.documents.length} queries=${queries.queries.length} -> ${out}`,
		);
	} else {
		console.log(JSON.stringify({ corpus, queries }, null, 2));
	}
}
