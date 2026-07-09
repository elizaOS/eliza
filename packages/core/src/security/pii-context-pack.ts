/**
 * Context-retrieval pass for the PII scrub pipeline (#14805).
 *
 * Stage position: between candidate-mining and the LLM-pass. A scrubber that
 * sees only the chunk cannot classify: is "Paris" a person or a city? does
 * "Dr. K" corefer with an entity already pseudonymized elsewhere? Before the
 * LLM-pass judges a chunk, this pass gathers related memories, knowledge,
 * conversations, and resolved-entity candidates so the verdict is
 * context-aware, and extracts the per-chunk pseudonym-assignment slice so the
 * rewrite is consistent with the corpus-wide map
 * ({@link ./pii-pseudonym-map | CorpusPseudonymMap}).
 *
 * Retrieval sources (all existing infra — this module builds none):
 * - **Entity resolution** — the alias backbone. The structural
 *   {@link PiiEntityResolverStore} seam matches `EntityStore.resolve`
 *   (`packages/agent/src/services/knowledge-graph/entity-store.ts`) exactly, so
 *   the pipeline wires `entityResolverFromStore(kg.getEntityStore())` with zero
 *   adaptation; standalone/batch callers construct the store with just
 *   `{agentId, adapter.db.execute}` per the issue. Identity merges keep going
 *   through the merge engine — this pass only READS resolution candidates.
 * - **Knowledge** — `DocumentService.searchDocuments` (hybrid vector+BM25).
 * - **Memories** — `runtime.searchMemories` with the caller-supplied embedding
 *   from `runtime.useModel(TEXT_EMBEDDING)`; the embeddings doctrine holds
 *   (a failure THROWS — never fabricate). When no embedding model is
 *   registered the source is structurally absent (a configuration fact,
 *   recorded in `sourcesQueried`), not silently empty.
 * - **Conversations** — `adapter.searchMessages` FTS; requires explicit
 *   `roomIds` (enumerate via `getRoomsByWorld` / `getRoomsForParticipant`).
 *
 * Failure doctrine: an ABSENT source is skipped and audited; a PRESENT source
 * that throws propagates (fail-closed — the scrub rails retry the item;
 * degraded context silently producing a wrong verdict is the failure mode this
 * pass exists to prevent).
 *
 * Secrecy: the assembled pack text contains retrieved corpus fragments (they
 * flow only to the PII_SCRUB model seam, local-first by registration priority)
 * but NEVER the pseudonym map — assignments travel separately as the
 * `{entityClusterId, surrogate, kind}` slice for exactly the clusters relevant
 * to this chunk, never the whole secret artifact and never a real alias.
 */

import type { PiiScrubRequestPayload } from "../types/events.js";
import type { Memory, UUID } from "../types/index.js";
import type {
	PiiPseudonymAssignment,
	TextEmbeddingParams,
} from "../types/model.js";
import { ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { Service } from "../types/service.js";
import { canonicalKind } from "./entity-recognizer.js";
import type { CorpusPseudonymMap } from "./pii-pseudonym-map.js";

/**
 * One mined candidate from the candidate-mining stage — the issue's input
 * shape: `{surfaceForm, kind, sourceRef: {memoryId|documentId, tableName,
 * fragment position}, span}`.
 */
export interface PiiScrubCandidate {
	/** The surface form as it appears in the chunk ("Dr. K", "@jsmith"). */
	readonly surfaceForm: string;
	/** Mined entity class guess (`person`, `org`, `location`, …). */
	readonly kind: string;
	/** Where the candidate was mined from. */
	readonly sourceRef?: {
		readonly memoryId?: string;
		readonly documentId?: string;
		readonly tableName?: string;
		/** Fragment position within the parent document, when applicable. */
		readonly position?: number;
	};
	/** Offsets of the surface form within the chunk. */
	readonly span?: { readonly start: number; readonly end: number };
	/**
	 * Platform identity, when the candidate IS a handle mined from a platform
	 * mirror (e.g. `{platform: "discord", handle: "jsmith"}`). Drives exact
	 * identity-based entity resolution.
	 */
	readonly identity?: { readonly platform: string; readonly handle: string };
}

/** One retrieved context fragment, ranked and bounded into the pack. */
export interface PiiContextFragment {
	readonly text: string;
	readonly origin: "document" | "memory" | "message" | "attachment";
	/** Source row/document id, for the audit trail. */
	readonly ref?: string;
	/** Relevance in [0,1] when the source measured one (never fabricated). */
	readonly score?: number;
}

/**
 * A resolved entity candidate, normalized for the scrub pipeline. `clusterId`
 * is the stable corpus-map key (`entity:<entityId>` for EntityStore-backed
 * resolution).
 */
export interface PiiResolvedEntity {
	readonly clusterId: string;
	readonly kind: string;
	/** Known surface forms: preferred name, full name, identity handles. */
	readonly aliases: readonly string[];
	readonly identities: readonly {
		readonly platform: string;
		readonly handle: string;
	}[];
	readonly confidence: number;
	readonly evidence: readonly string[];
}

/**
 * Structural subset of `EntityStore` (the alias backbone) that this pass
 * consumes — field-for-field the shape of
 * `EntityStore.resolve({name?, identity?, type?}) → EntityResolveCandidate[]`
 * so the real store satisfies it with zero adaptation.
 */
export interface PiiEntityResolverStore {
	resolve(query: {
		name?: string;
		identity?: { platform: string; handle: string };
		type?: string;
	}): Promise<
		readonly {
			readonly entity: {
				readonly entityId: string;
				readonly type: string;
				readonly preferredName: string;
				readonly fullName?: string;
				readonly identities: readonly {
					readonly platform: string;
					readonly handle: string;
				}[];
			};
			readonly confidence: number;
			readonly evidence: readonly string[];
		}[]
	>;
}

/** The retrieval seams the pass draws from. Absent = not available (audited). */
export interface PiiContextSources {
	readonly resolveEntity?: (
		candidate: PiiScrubCandidate,
	) => Promise<readonly PiiResolvedEntity[]>;
	readonly searchDocuments?: (
		query: string,
	) => Promise<readonly PiiContextFragment[]>;
	readonly searchMemories?: (
		query: string,
	) => Promise<readonly PiiContextFragment[]>;
	readonly searchMessages?: (
		query: string,
	) => Promise<readonly PiiContextFragment[]>;
}

/** Output 1 of the stage: the context pack for the LLM-pass. */
export interface PiiContextPack {
	/**
	 * Bounded, human-readable context text for the `PII_SCRUB` model call:
	 * resolved-entity summaries (with the assigned pseudonym marker when the
	 * cluster is already mapped) + nearest fragments. Never the secret map.
	 */
	readonly contextPack: string;
	/** The per-chunk cluster→surrogate slice (never the whole map). */
	readonly assignments: readonly PiiPseudonymAssignment[];
	/** Entity candidates that resolved with sufficient confidence. */
	readonly resolvedEntities: readonly PiiResolvedEntity[];
	/** Candidate surface forms, deduped — the seam's `candidateSpans`. */
	readonly candidateSpans: readonly string[];
	/** Which sources were queried vs structurally absent (audit). */
	readonly sourcesQueried: readonly string[];
}

export interface AssembleContextPackRequest {
	/** The chunk of text the LLM-pass will judge. */
	readonly chunk: string;
	/** Mined candidates for this chunk. */
	readonly candidates: readonly PiiScrubCandidate[];
	/** The corpus pseudonym map (read + upserted for confident resolutions). */
	readonly map: CorpusPseudonymMap;
	/** Active ruleset version (threaded into map assignments). */
	readonly rulesetVersion: string;
	/**
	 * Minimum resolution confidence for a candidate to be clustered into the
	 * map. Below it, the entity still appears in the pack (as context) but no
	 * assignment is made. Default 0.6 — the EntityStore's exact-name match
	 * scores 0.9, substring 0.55, so defaults cluster exact/identity matches
	 * and leave fuzzy ones to the model.
	 */
	readonly minEntityConfidence?: number;
	/** Max fragments folded into the pack (default 8). */
	readonly maxFragments?: number;
	/** Max pack characters (default 4000). Fragments are trimmed to fit. */
	readonly maxChars?: number;
}

const DEFAULT_MIN_ENTITY_CONFIDENCE = 0.6;
const DEFAULT_MAX_FRAGMENTS = 8;
const DEFAULT_MAX_CHARS = 4000;

/**
 * Assemble the context pack + pseudonym-assignment slice for one chunk.
 * See the module doc for the source/failure/secrecy contract.
 */
export async function assembleContextPack(
	sources: PiiContextSources,
	request: AssembleContextPackRequest,
): Promise<PiiContextPack> {
	const {
		chunk,
		candidates,
		map,
		rulesetVersion,
		minEntityConfidence = DEFAULT_MIN_ENTITY_CONFIDENCE,
		maxFragments = DEFAULT_MAX_FRAGMENTS,
		maxChars = DEFAULT_MAX_CHARS,
	} = request;

	const sourcesQueried: string[] = [];
	const resolvedEntities: PiiResolvedEntity[] = [];
	const fragments: PiiContextFragment[] = [];

	// Dedupe candidate surface forms (the seam's candidateSpans) while keeping
	// first-seen order; drop empty/whitespace forms (adversarial input).
	const candidateSpans: string[] = [];
	const seenSpans = new Set<string>();
	for (const candidate of candidates) {
		const form = candidate.surfaceForm?.trim();
		if (!form) continue;
		if (seenSpans.has(form)) continue;
		seenSpans.add(form);
		candidateSpans.push(form);
	}

	// 1. Entity resolution — the alias backbone. Confident resolutions are
	// upserted into the corpus map so this person's pseudonym is the SAME one
	// every other artifact got.
	if (sources.resolveEntity) {
		sourcesQueried.push("entities");
		const seenClusters = new Set<string>();
		for (const candidate of candidates) {
			if (!candidate.surfaceForm?.trim()) continue;
			const resolved = await sources.resolveEntity(candidate);
			for (const entity of resolved) {
				if (seenClusters.has(entity.clusterId)) continue;
				seenClusters.add(entity.clusterId);
				resolvedEntities.push(entity);
				if (entity.confidence >= minEntityConfidence) {
					map.assign({
						clusterId: entity.clusterId,
						kind: entity.kind,
						aliases: [candidate.surfaceForm.trim(), ...entity.aliases],
						identities: entity.identities,
						evidence: entity.evidence,
						rulesetVersion,
					});
				}
			}
		}
	}

	// 2. Related fragments, one query per distinct surface form per source.
	const fragmentSources: [
		string,
		((query: string) => Promise<readonly PiiContextFragment[]>) | undefined,
	][] = [
		["documents", sources.searchDocuments],
		["memories", sources.searchMemories],
		["messages", sources.searchMessages],
	];
	for (const [name, search] of fragmentSources) {
		if (!search) continue;
		sourcesQueried.push(name);
		for (const form of candidateSpans) {
			const results = await search(form);
			for (const fragment of results) {
				if (typeof fragment.text === "string" && fragment.text.trim()) {
					fragments.push(fragment);
				}
			}
		}
	}

	// Rank (measured scores first, descending; unscored keep arrival order) and
	// bound the pack.
	fragments.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	const kept = fragments.slice(0, maxFragments);

	// 3. The per-chunk assignment slice: clusters whose aliases occur in the
	// chunk, plus clusters resolved above. NEVER the whole map.
	const assignments = new Map<string, PiiPseudonymAssignment>();
	for (const assignment of map.assignmentsForText(chunk)) {
		assignments.set(assignment.entityClusterId, assignment);
	}
	for (const entity of resolvedEntities) {
		const assignment = map.assignmentFor(entity.clusterId);
		if (assignment) assignments.set(assignment.entityClusterId, assignment);
	}

	// 4. Render the bounded pack text. Entity summaries state that a cluster is
	// already mapped WITHOUT embedding the alias→pseudonym pair: the surrogate
	// itself rides in `pseudonymAssignments`, keyed by cluster id.
	const sections: string[] = [];
	if (resolvedEntities.length > 0) {
		const lines = resolvedEntities.map((entity) => {
			const mapped = map.assignmentFor(entity.clusterId)
				? " [cluster already pseudonymized — reuse its assignment]"
				: "";
			const handles = entity.identities
				.map((i) => `${i.platform}:${i.handle}`)
				.join(", ");
			return `- ${entity.clusterId} (${entity.kind}, confidence ${entity.confidence.toFixed(2)}${
				handles ? `, identities: ${handles}` : ""
			})${mapped}`;
		});
		sections.push(`Resolved entity candidates:\n${lines.join("\n")}`);
	}
	if (kept.length > 0) {
		const lines = kept.map(
			(f) => `- [${f.origin}${f.ref ? ` ${f.ref}` : ""}] ${f.text.trim()}`,
		);
		sections.push(`Related context:\n${lines.join("\n")}`);
	}
	let contextPack = sections.join("\n\n");
	if (contextPack.length > maxChars) {
		contextPack = contextPack.slice(0, maxChars);
	}

	return {
		contextPack,
		assignments: [...assignments.values()],
		resolvedEntities,
		candidateSpans,
		sourcesQueried,
	};
}

/**
 * Adapt anything with `EntityStore.resolve`'s shape into the pass's
 * `resolveEntity` seam. The stable corpus-map cluster id is
 * `entity:<entityId>`; kinds are canonicalized to the pseudonymizer's
 * vocabulary (`organization` → `org`, …) via {@link canonicalKind}.
 */
export function entityResolverFromStore(
	store: PiiEntityResolverStore,
	options: { maxCandidates?: number } = {},
): (candidate: PiiScrubCandidate) => Promise<readonly PiiResolvedEntity[]> {
	const maxCandidates = options.maxCandidates ?? 3;
	return async (candidate) => {
		const query: {
			name?: string;
			identity?: { platform: string; handle: string };
		} = candidate.identity
			? { identity: candidate.identity }
			: { name: candidate.surfaceForm.trim() };
		const resolved = await store.resolve(query);
		return resolved.slice(0, maxCandidates).map((match) => {
			const aliases = [
				match.entity.preferredName,
				...(match.entity.fullName ? [match.entity.fullName] : []),
				...match.entity.identities.map((identity) => identity.handle),
			];
			return {
				clusterId: `entity:${match.entity.entityId}`,
				kind: canonicalKind(match.entity.type),
				aliases,
				identities: match.entity.identities.map((identity) => ({
					platform: identity.platform,
					handle: identity.handle,
				})),
				confidence: match.confidence,
				evidence: match.evidence,
			};
		});
	};
}

export interface RuntimeContextSourceOptions {
	/**
	 * Rooms for conversation FTS (`adapter.searchMessages` requires explicit
	 * roomIds — enumerate via `getRoomsByWorld` / `getRoomsForParticipant`).
	 * When omitted, the messages source is structurally absent.
	 */
	readonly roomIds?: readonly UUID[];
	/** Per-source result limit (default 5). */
	readonly limit?: number;
	/**
	 * The entity resolver, wired by the pipeline from the knowledge-graph
	 * service (`entityResolverFromStore(kg.getEntityStore())`). Core does not
	 * reach into `@elizaos/agent`, so this is injected.
	 */
	readonly resolveEntity?: PiiContextSources["resolveEntity"];
}

/** Structural view of the documents service (`DocumentService`). */
interface DocumentSearchService {
	searchDocuments(
		message: Memory,
	): Promise<
		readonly { id: UUID; content: { text?: string }; similarity?: number }[]
	>;
}

/**
 * Wire {@link PiiContextSources} from a live runtime using only existing
 * surfaces: the documents service (hybrid search, keyword fallback built-in),
 * `runtime.searchMemories` (only when a TEXT_EMBEDDING model is registered —
 * the embeddings doctrine throws on failure, never fabricates), and
 * `adapter.searchMessages` (only when `roomIds` are supplied).
 */
export function sourcesFromRuntime(
	runtime: IAgentRuntime,
	options: RuntimeContextSourceOptions = {},
): PiiContextSources {
	const limit = options.limit ?? 5;
	const sources: {
		-readonly [K in keyof PiiContextSources]: PiiContextSources[K];
	} = {};

	if (options.resolveEntity) {
		sources.resolveEntity = options.resolveEntity;
	}

	const documents = runtime.getService("documents") as
		| (Service & Partial<DocumentSearchService>)
		| null;
	const searchDocumentsFn = documents?.searchDocuments;
	if (documents && typeof searchDocumentsFn === "function") {
		sources.searchDocuments = async (query) => {
			const results = await searchDocumentsFn.call(documents, {
				entityId: runtime.agentId,
				roomId: (options.roomIds?.[0] ?? runtime.agentId) as UUID,
				content: { text: query },
			});
			return results.slice(0, limit).map((doc) => ({
				text: doc.content.text ?? "",
				origin: "document" as const,
				ref: doc.id,
				...(typeof doc.similarity === "number"
					? { score: doc.similarity }
					: {}),
			}));
		};
	}

	if (runtime.getModel(ModelType.TEXT_EMBEDDING)) {
		sources.searchMemories = async (query) => {
			const params: TextEmbeddingParams = { text: query };
			// Embeddings doctrine: a failure here THROWS (#9324) — the pass never
			// degrades to a fabricated empty context for a wired source.
			const embedding = await runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				params,
			);
			const memories = await runtime.searchMemories({
				embedding,
				query,
				tableName: "messages",
				count: limit,
			});
			return memories
				.filter((memory) => typeof memory.content.text === "string")
				.map((memory) => ({
					text: memory.content.text as string,
					origin: "memory" as const,
					ref: memory.id,
					...(typeof memory.similarity === "number"
						? { score: memory.similarity }
						: {}),
				}));
		};
	}

	const roomIds = options.roomIds;
	if (roomIds && roomIds.length > 0) {
		sources.searchMessages = async (query) => {
			const hits = await runtime.adapter.searchMessages({
				roomIds: [...roomIds],
				query,
				limit,
			});
			return hits
				.filter((hit) => typeof hit.memory.content.text === "string")
				.map((hit) => ({
					text: hit.memory.content.text as string,
					origin: "message" as const,
					ref: hit.memory.id,
					// ftsRank is unbounded; trigramSimilarity is already [0,1]. Use the
					// trigram signal for cross-source ranking, real and measured.
					score: hit.trigramSimilarity,
				}));
		};
	}

	return sources;
}

/**
 * Fold a chunk + its assembled context pack into the scrub-rails request
 * payload (`PII_SCRUB_REQUESTED`, drained by `PiiScrubService`). The payload
 * carries the pack text and the per-chunk assignment slice into the merged
 * seam (`scrubWithEscalation`) with ZERO changes to the landed rails. The
 * emitter supplies `runtime` at `emitEvent` time.
 */
export function buildScrubRequestDraft(input: {
	readonly content: string;
	readonly rulesetVersion: string;
	readonly pack: PiiContextPack;
	readonly priority?: PiiScrubRequestPayload["priority"];
	readonly inferencePriority?: PiiScrubRequestPayload["inferencePriority"];
	readonly jobId?: PiiScrubRequestPayload["jobId"];
	readonly itemRef?: string;
}): Omit<PiiScrubRequestPayload, "runtime"> {
	return {
		content: input.content,
		rulesetVersion: input.rulesetVersion,
		candidateSpans: input.pack.candidateSpans,
		contextPack: input.pack.contextPack,
		pseudonymAssignments: input.pack.assignments,
		priority: input.priority,
		inferencePriority: input.inferencePriority,
		jobId: input.jobId,
		itemRef: input.itemRef,
		source: "pii-context-pack",
	};
}
