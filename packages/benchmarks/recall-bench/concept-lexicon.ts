/**
 * Shared concept lexicon for recall-bench (#9956).
 *
 * The single source of truth for the topic vocabularies, used by BOTH the
 * corpus generator (templated docs + queries) and the deterministic embedding
 * model. Each topic has a set of CONCEPTS; each concept has a canonical surface
 * term (used in documents + exact queries) and a synonym phrase (used in
 * paraphrase queries) that shares NO tokens with the canonical term. Because
 * the embedding maps both surfaces of a concept to the same concept anchor, a
 * synonym query lands in vector space near the documents that use the canonical
 * term — even though they share no tokens — which is exactly the
 * semantic-but-non-lexical recall a real embedding provides and BM25 cannot.
 *
 * This is a tiny hand-built but REAL embedding model: deterministic, key-free,
 * reproducible, and dispatched by the runtime exactly like a cloud model.
 */

export interface Concept {
	/** Stable concept id (the anchor key). */
	id: string;
	/** Canonical surface term — appears in documents + exact queries. */
	canonical: string;
	/** Synonym phrase — appears in paraphrase queries; shares no token with canonical. */
	synonym: string;
}

export interface TopicDef {
	id: string;
	domain: string;
	concepts: Concept[];
}

export const TOPIC_DEFS: TopicDef[] = [
	{
		id: "kubernetes-networking",
		domain: "devops",
		concepts: [
			{ id: "k8s-pod", canonical: "pod", synonym: "containerized workload unit" },
			{ id: "k8s-clusterip", canonical: "cluster ip", synonym: "internal virtual routing address" },
			{ id: "k8s-cni", canonical: "cni plugin", synonym: "container interface extension" },
			{ id: "k8s-kubeproxy", canonical: "kube-proxy", synonym: "node traffic forwarder" },
			{ id: "k8s-mesh", canonical: "service mesh", synonym: "sidecar connectivity layer" },
		],
	},
	{
		id: "postgres-indexing",
		domain: "databases",
		concepts: [
			{ id: "pg-btree", canonical: "btree index", synonym: "balanced lookup tree structure" },
			{ id: "pg-vacuum", canonical: "vacuum", synonym: "dead tuple reclamation" },
			{ id: "pg-planner", canonical: "query planner", synonym: "execution strategy optimizer" },
			{ id: "pg-tablespace", canonical: "tablespace", synonym: "physical disk storage location" },
			{ id: "pg-wal", canonical: "wal", synonym: "write ahead journaling" },
		],
	},
	{
		id: "tcp-congestion",
		domain: "networking",
		concepts: [
			{ id: "tcp-slowstart", canonical: "slow start", synonym: "gradual sending ramp up" },
			{ id: "tcp-cwnd", canonical: "cwnd", synonym: "transmit window sizing" },
			{ id: "tcp-retransmit", canonical: "retransmission", synonym: "resending dropped segments" },
			{ id: "tcp-rtt", canonical: "rtt estimate", synonym: "round trip delay measurement" },
			{ id: "tcp-sack", canonical: "sack", synonym: "selective acknowledgement" },
		],
	},
	{
		id: "rust-ownership",
		domain: "programming-languages",
		concepts: [
			{ id: "rust-borrow", canonical: "borrow checker", synonym: "compile time reference validator" },
			{ id: "rust-lifetime", canonical: "lifetime", synonym: "reference validity scope" },
			{ id: "rust-move", canonical: "move semantics", synonym: "value transfer rules" },
			{ id: "rust-trait", canonical: "trait bound", synonym: "interface constraint" },
			{ id: "rust-drop", canonical: "drop", synonym: "resource cleanup hook" },
		],
	},
	{
		id: "photosynthesis",
		domain: "biology",
		concepts: [
			{ id: "bio-chloroplast", canonical: "chloroplast", synonym: "green energy organelle" },
			{ id: "bio-calvin", canonical: "calvin cycle", synonym: "carbon fixation pathway" },
			{ id: "bio-stomata", canonical: "stomata", synonym: "leaf gas exchange pores" },
			{ id: "bio-rubisco", canonical: "rubisco", synonym: "carbon capture enzyme" },
			{ id: "bio-thylakoid", canonical: "thylakoid", synonym: "stacked membrane sac" },
		],
	},
	{
		id: "monetary-policy",
		domain: "economics",
		concepts: [
			{ id: "econ-rate", canonical: "interest rate", synonym: "borrowing cost level" },
			{ id: "econ-omo", canonical: "open market", synonym: "bond buying operations" },
			{ id: "econ-reserve", canonical: "reserve ratio", synonym: "mandatory deposit fraction" },
			{ id: "econ-target", canonical: "inflation target", synonym: "price stability goal" },
			{ id: "econ-liquidity", canonical: "liquidity", synonym: "cash availability buffer" },
		],
	},
	{
		id: "jet-propulsion",
		domain: "aerospace",
		concepts: [
			{ id: "aero-turbofan", canonical: "turbofan", synonym: "ducted fan engine" },
			{ id: "aero-bypass", canonical: "bypass ratio", synonym: "cold to hot airflow proportion" },
			{ id: "aero-afterburner", canonical: "afterburner", synonym: "reheat thrust booster" },
			{ id: "aero-compressor", canonical: "compressor stage", synonym: "air pressurizing rotor row" },
			{ id: "aero-nozzle", canonical: "nozzle", synonym: "exhaust acceleration outlet" },
		],
	},
	{
		id: "coffee-roasting",
		domain: "culinary",
		concepts: [
			{ id: "coffee-crack", canonical: "first crack", synonym: "initial popping stage" },
			{ id: "coffee-maillard", canonical: "maillard", synonym: "browning flavor reaction" },
			{ id: "coffee-degas", canonical: "degassing", synonym: "carbon dioxide release" },
			{ id: "coffee-curve", canonical: "roast curve", synonym: "temperature time profile" },
			{ id: "coffee-density", canonical: "bean density", synonym: "seed mass per volume" },
		],
	},
];

/** All concept ids, in a stable order — used to assign each a vector anchor. */
export const CONCEPT_IDS: string[] = TOPIC_DEFS.flatMap((t) =>
	t.concepts.map((c) => c.id),
);

/**
 * Surface phrase (lowercased canonical OR synonym) -> concept id. Phrases are
 * matched greedily (longest first) so multi-word concept phrases win over their
 * constituent tokens.
 */
export const PHRASE_TO_CONCEPT: { phrase: string; conceptId: string }[] = (() => {
	const list: { phrase: string; conceptId: string }[] = [];
	for (const t of TOPIC_DEFS) {
		for (const c of t.concepts) {
			list.push({ phrase: c.canonical.toLowerCase(), conceptId: c.id });
			list.push({ phrase: c.synonym.toLowerCase(), conceptId: c.id });
		}
	}
	// Longest phrase first so "cluster ip" matches before "ip".
	list.sort((a, b) => b.phrase.length - a.phrase.length);
	return list;
})();

/**
 * Detect concept ids present in a text by greedy longest-phrase matching.
 * Matched spans are consumed so a phrase can't double-count.
 */
export function detectConcepts(text: string): string[] {
	let haystack = ` ${text.toLowerCase()} `;
	const found: string[] = [];
	for (const { phrase, conceptId } of PHRASE_TO_CONCEPT) {
		const needle = ` ${phrase} `;
		const idx = haystack.indexOf(needle);
		if (idx >= 0) {
			found.push(conceptId);
			// Consume the span so its tokens don't re-match a shorter phrase.
			haystack = `${haystack.slice(0, idx + 1)}${" ".repeat(phrase.length)}${haystack.slice(idx + 1 + phrase.length)}`;
		}
	}
	return found;
}
