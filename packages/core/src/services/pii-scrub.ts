/**
 * Long-lived singleton that owns the async PII scrub job rails (#14808).
 *
 * This is the LOCAL-lane execution substrate for the corpus PII scrub. It is a
 * 1:1 structural mirror of {@link EmbeddingGenerationService}
 * (`packages/core/src/services/embedding.ts`): it listens for a trigger event
 * (`PII_SCRUB_REQUESTED`, like `EMBEDDING_GENERATION_REQUESTED`), drains a
 * priority `BatchQueue` (`packages/core/src/utils/batch-queue.ts`) on the core
 * task scheduler, and processes each item without ever blocking an agent turn.
 * No new scheduler, no new queue - the rails already exist in-repo.
 *
 * Per item it:
 *   1. Computes the source-scoped done-marker
 *      `pii:<sha256(content)>:v<rulesetVersion>:source:<sha256(itemRef)>` and
 *      skips only when that source artifact is already complete.
 *   2. Escalates through the merged seam
 *      (`scrubWithEscalation`, #14980/#14809): tier-0 deterministic detectors
 *      run first (free, no model call); only residue candidates hit the
 *      `PII_SCRUB` model with `priority: "background"` so the scrub never
 *      preempts an interactive turn. The seam is fail-closed - un-inspectable
 *      residue throws, which routes the item through `onExhausted` / retry and
 *      the done-marker is NOT written (the item stays quarantined, never
 *      silently passed as clean).
 *   3. Writes the done-marker ONLY after a successful scrub, then emits
 *      `PII_SCRUB_COMPLETED` for progress/observability. Failures emit
 *      `PII_SCRUB_FAILED` and are surfaced via `runtime.reportError`
 *      (RECENT_ERRORS provider + owner escalation).
 *
 * `PII_SCRUB` is supplied by a dedicated privacy provider such as the
 * local-inference plugin. If no dedicated handler can inspect residue, the item
 * fails closed and remains unmarked; core never forwards raw PII through a
 * general-purpose text route.
 *
 * OUT OF SCOPE for this service (sibling issues / later slices): the CLOUD lane
 * (routing/resolve/jobsRepository/Redis+cron) and alternate provider-specific
 * scrub handlers.
 */

import { ElizaError } from "../errors.js";
import {
	PII_ENTITY_RECOGNIZER_SERVICE,
	type PiiEntityRecognizerService,
} from "../security/entity-recognizer.js";
import {
	entityResolverFromStore,
	type PiiEntityResolverStore,
	type PiiScrubCandidate,
	sourcesFromRuntime,
} from "../security/pii-context-pack.js";
import {
	getScrubMarker,
	isScrubDone,
	markScrubDone,
} from "../security/pii-scrub-markers.js";
import {
	applyScrubWriteBack,
	enqueuePiiScrub,
	mineTier0Candidates,
} from "../security/pii-scrub-pipeline.js";
import {
	PiiScrubFabricationError,
	scrubWithEscalation,
	type Tier0Span,
} from "../security/pii-scrub-seam.js";
import type { PiiScrubRequestPayload } from "../types/events.js";
import { EventType } from "../types/events.js";
import type { PiiScrubVerdict } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { Service } from "../types/service.js";
import { BatchQueue } from "../utils/batch-queue.js";

/** One unit of scrub work on the drain queue. */
interface PiiScrubQueueItem {
	content: string;
	rulesetVersion: string;
	candidateSpans: readonly string[];
	contextPack?: string;
	pseudonymAssignments?: PiiScrubRequestPayload["pseudonymAssignments"];
	priority: "high" | "normal" | "low";
	inferencePriority: "interactive" | "background";
	jobId?: string;
	itemRef: string;
	writeBack: PiiScrubRequestPayload["writeBack"];
}

const SRC = "plugin:basic-capabilities:service:pii-scrub";
const MEMORY_HOOK_ID = "core:pii-scrub:after-memory-persisted";
export const PII_SCRUB_RULESET_VERSION = "2026.08";

interface KnowledgeGraphServiceView extends Service {
	getEntityStore(): PiiEntityResolverStore;
}

const PROPER_NAME_PATTERN =
	/\b[A-Z][\p{L}'-]{1,}(?:\s+[A-Z][\p{L}'-]{1,}){1,3}\b/gu;

function addCandidate(
	candidates: PiiScrubCandidate[],
	seen: Set<string>,
	candidate: PiiScrubCandidate,
): void {
	const value = candidate.surfaceForm.trim();
	if (!value || seen.has(value)) return;
	seen.add(value);
	candidates.push({ ...candidate, surfaceForm: value });
}

async function mineLiveCandidates(
	runtime: IAgentRuntime,
	text: string,
	entityId: string,
): Promise<PiiScrubCandidate[]> {
	const candidates: PiiScrubCandidate[] = [];
	const seen = new Set<string>();
	for (const candidate of mineTier0Candidates(text)) {
		addCandidate(candidates, seen, candidate);
	}

	const recognizerService = runtime.getService<
		Service & PiiEntityRecognizerService
	>(PII_ENTITY_RECOGNIZER_SERVICE);
	const recognizer = recognizerService?.getRecognizer();
	if (recognizer) {
		for (const span of await recognizer.recognize(text)) {
			addCandidate(candidates, seen, {
				surfaceForm: span.value,
				kind: span.kind,
				...(span.start !== undefined && span.end !== undefined
					? { span: { start: span.start, end: span.end } }
					: {}),
			});
		}
	}

	const sourceEntity = await runtime.getEntityById(entityId);
	for (const name of sourceEntity?.names ?? []) {
		const start = text.indexOf(name);
		if (start >= 0) {
			addCandidate(candidates, seen, {
				surfaceForm: name,
				kind: "person",
				span: { start, end: start + name.length },
			});
		}
	}

	for (const match of text.matchAll(PROPER_NAME_PATTERN)) {
		const start = match.index;
		addCandidate(candidates, seen, {
			surfaceForm: match[0],
			kind: "person",
			span: { start, end: start + match[0].length },
		});
	}
	addCandidate(candidates, seen, {
		surfaceForm: text,
		kind: "free_text",
		span: { start: 0, end: text.length },
	});
	return candidates;
}

/**
 * Service responsible for running the corpus PII scrub asynchronously on the
 * core task queue. Mirrors {@link EmbeddingGenerationService}.
 */
export class PiiScrubService extends Service {
	static serviceType = "pii-scrub";
	capabilityDescription =
		"Runs the corpus PII scrub asynchronously on the core task queue (source-scoped idempotency, non-blocking)";

	private batchQueue: BatchQueue<PiiScrubQueueItem> | null = null;
	private isDisabled = false;

	private static readonly SCRUB_DRAIN_TASK = "PII_SCRUB_DRAIN";

	static async start(runtime: IAgentRuntime): Promise<Service> {
		runtime.logger.info(
			{ src: SRC, agentId: runtime.agentId },
			"Starting PII scrub service",
		);
		const service = new PiiScrubService(runtime);
		await service.initialize();
		return service;
	}

	async initialize(): Promise<void> {
		if (this.isDisabled) {
			return;
		}

		this.runtime.logger.info(
			{ src: SRC, agentId: this.runtime.agentId },
			"Initializing PII scrub service",
		);

		this.runtime.registerEvent(
			EventType.PII_SCRUB_REQUESTED,
			this.handleScrubRequest.bind(this),
		);
		this.runtime.registerPipelineHook({
			id: MEMORY_HOOK_ID,
			phase: "after_memory_persisted",
			schedule: "serial",
			mutatesPrimary: false,
			handler: async (_runtime, ctx) => {
				if (ctx.phase !== "after_memory_persisted") return;
				const originalText = ctx.memory.content.text;
				if (typeof originalText !== "string" || originalText.length === 0) {
					return;
				}
				const candidates = await mineLiveCandidates(
					this.runtime,
					originalText,
					ctx.memory.entityId,
				);
				const knowledgeGraph =
					this.runtime.getService<KnowledgeGraphServiceView>(
						"eliza_knowledge_graph",
					);
				const sources = sourcesFromRuntime(this.runtime, {
					roomIds: [ctx.memory.roomId],
					localOnly: true,
					...(knowledgeGraph
						? {
								resolveEntity: entityResolverFromStore(
									knowledgeGraph.getEntityStore(),
								),
							}
						: {}),
				});

				await enqueuePiiScrub(
					this.runtime,
					{
						content: originalText,
						itemRef: ctx.memoryId,
						candidates,
						writeBack: async (scrubbedText) => {
							const current = await this.runtime.getMemoryById(ctx.memoryId);
							if (!current) {
								throw new ElizaError(
									"PII scrub source memory no longer exists",
									{
										code: "PII_SCRUB_SOURCE_MISSING",
										context: { memoryId: ctx.memoryId },
									},
								);
							}
							if (current.content.text !== originalText) {
								throw new ElizaError(
									"PII scrub source changed before write-back",
									{
										code: "PII_SCRUB_SOURCE_CHANGED",
										context: { memoryId: ctx.memoryId },
									},
								);
							}
							const updated = await this.runtime.updateMemory({
								id: ctx.memoryId,
								content: { ...current.content, text: scrubbedText },
							});
							if (!updated) {
								throw new ElizaError(
									"PII scrub source write-back was rejected",
									{
										code: "PII_SCRUB_WRITE_BACK_REJECTED",
										context: { memoryId: ctx.memoryId },
									},
								);
							}
						},
					},
					{ rulesetVersion: PII_SCRUB_RULESET_VERSION, sources },
				);
			},
		});

		// Same drain/retry/priority model as the embedding service - the task
		// system owns WHEN (repeat PII_SCRUB_DRAIN tick), we own WHAT (dequeue,
		// escalate, mark-done). No maxSize: the bottleneck is model I/O, not
		// queue length. No processBatch: the seam is a per-item escalation with
		// per-source content-addressed idempotency, so there is no single-call
		// batch collapse to exploit (each item's tier-0 residue is distinct).
		this.batchQueue = new BatchQueue<PiiScrubQueueItem>({
			name: PiiScrubService.SCRUB_DRAIN_TASK,
			taskDescription: "PII scrub drain",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: (item) => item.priority,
			// Serial by default: the scrub is background work that must not fan a
			// burst of model calls ahead of an interactive turn. `background`
			// priority on each call is the gate; low parallelism keeps the local
			// device from thrashing.
			maxParallel: 2,
			maxRetriesAfterFailure: 3,
			process: (item) => this.scrubItem(item),
			onExhausted: async (item, error) => {
				await this.emitFailure(item, error);
			},
		});

		await this.batchQueue.start(this.runtime);

		this.runtime.logger.info(
			{ src: SRC, agentId: this.runtime.agentId },
			"Started PII scrub drain task",
		);
	}

	private async handleScrubRequest(
		payload: PiiScrubRequestPayload,
	): Promise<void> {
		if (this.isDisabled || !this.batchQueue) {
			return;
		}

		const content = payload.content;
		if (typeof content !== "string" || content.length === 0) {
			this.runtime.logger.debug(
				{ src: SRC, agentId: this.runtime.agentId },
				"Empty scrub content, skipping",
			);
			return;
		}
		if (
			typeof payload.rulesetVersion !== "string" ||
			payload.rulesetVersion.length === 0
		) {
			this.runtime.logger.warn(
				{ src: SRC, agentId: this.runtime.agentId },
				"Scrub request missing rulesetVersion, skipping (cannot key done-marker)",
			);
			return;
		}
		if (typeof payload.itemRef !== "string" || payload.itemRef.length === 0) {
			throw new ElizaError(
				"PII scrub request is missing its source reference",
				{
					code: "PII_SCRUB_SOURCE_REF_REQUIRED",
				},
			);
		}
		if (typeof payload.writeBack !== "function") {
			throw new ElizaError("PII scrub request is missing durable write-back", {
				code: "PII_SCRUB_WRITE_BACK_REQUIRED",
				context: { itemRef: payload.itemRef },
			});
		}

		// Cheap pre-enqueue idempotency: if this exact content+ruleset is already
		// scrubbed, do not even queue it. The drain re-checks under the hood so a
		// race (two enqueues of the same content) still no-ops, but this avoids
		// the queue churn for the common re-scrub case.
		if (
			await isScrubDone(
				this.runtime,
				content,
				payload.rulesetVersion,
				payload.itemRef,
			)
		) {
			this.runtime.logger.debug(
				{ src: SRC, agentId: this.runtime.agentId, itemRef: payload.itemRef },
				"Content already scrubbed under this ruleset, skipping enqueue",
			);
			return;
		}

		// Destructuring default: an omitted candidateSpans is the designed
		// "detector offered no spans" input, not a broken pipeline.
		const { candidateSpans = [] } = payload;
		const item: PiiScrubQueueItem = {
			content,
			rulesetVersion: payload.rulesetVersion,
			candidateSpans,
			contextPack: payload.contextPack,
			pseudonymAssignments: payload.pseudonymAssignments,
			priority: payload.priority ?? "low",
			inferencePriority: payload.inferencePriority ?? "background",
			jobId: payload.jobId,
			itemRef: payload.itemRef,
			writeBack: payload.writeBack,
		};

		this.batchQueue.enqueue(item);
		this.runtime.logger.debug(
			{
				src: SRC,
				agentId: this.runtime.agentId,
				queueSize: this.batchQueue.size,
				itemRef: payload.itemRef,
			},
			"Enqueued scrub item",
		);
	}

	/**
	 * Process one item: idempotency skip -> seam escalation -> mark-done. Throws
	 * on any failure so BatchQueue applies retry / `onExhausted`, and CRUCIALLY
	 * does not write the done-marker on failure (the item is retried, never
	 * silently marked scrubbed).
	 */
	private async scrubItem(item: PiiScrubQueueItem): Promise<void> {
		// Idempotency re-check inside the drain: covers the race where the same
		// content was enqueued twice before either drained. A hit means another
		// drain already completed this exact content+ruleset - nothing to do.
		if (
			await isScrubDone(
				this.runtime,
				item.content,
				item.rulesetVersion,
				item.itemRef,
			)
		) {
			this.runtime.logger.debug(
				{ src: SRC, agentId: this.runtime.agentId, itemRef: item.itemRef },
				"Item already scrubbed (drain-time idempotency hit), skipping",
			);
			return;
		}

		let escalated: boolean;
		let modelId: string;
		let verdicts: readonly PiiScrubVerdict[] = [];
		let tier0Spans: readonly Tier0Span[] = [];
		try {
			const result = await scrubWithEscalation(this.runtime, {
				text: item.content,
				candidateSpans: item.candidateSpans,
				rulesetVersion: item.rulesetVersion,
				contextPack: item.contextPack,
				pseudonymAssignments: item.pseudonymAssignments,
				priority: item.inferencePriority,
			});
			escalated = result.escalated;
			modelId = result.escalation?.modelId ?? "tier0";
			verdicts = result.escalation?.verdicts ?? [];
			tier0Spans = result.tier0;
		} catch (error) {
			// error-policy:J2 Queue retry policy owns recovery; this layer adds job
			// diagnostics and rethrows without manufacturing a scrubbed result.
			// Fail-closed: a seam throw (no handler for residue, fabricated
			// result, model error) must NOT mark the item done. Rethrow so the
			// queue retries; if retries exhaust, `onExhausted` reports + emits
			// FAILED and the content stays quarantined.
			this.runtime.logger.error(
				{
					src: SRC,
					agentId: this.runtime.agentId,
					itemRef: item.itemRef,
					failClosed: error instanceof PiiScrubFabricationError,
					error: error instanceof Error ? error.message : String(error),
				},
				"Scrub item failed (fail-closed, not marking done)",
			);
			throw error;
		}

		// Apply the validated verdicts + tier-0 redaction to produce the scrubbed
		// text — the write-back transform. This closes the gap where the service
		// discarded verdicts and marked done without committing the rewrite. The
		// scrubbedText is emitted on PII_SCRUB_COMPLETED so write-back listeners
		// (memory/document updaters) can commit the transformed artifact.
		const scrubbedText = applyScrubWriteBack(
			item.content,
			tier0Spans,
			verdicts,
		);

		// The source adapter must confirm its durable write before this item can
		// become an idempotency hit. Rejections throw into the queue retry path.
		await item.writeBack(scrubbedText);

		// Success: write the source-scoped done-marker so this artifact's unchanged
		// content no-ops, without suppressing write-back for a second source.
		await markScrubDone(
			this.runtime,
			item.content,
			{
				rulesetVersion: item.rulesetVersion,
				modelId,
				tier0Only: !escalated,
			},
			item.itemRef,
		);

		await this.runtime.emitEvent(EventType.PII_SCRUB_COMPLETED, {
			runtime: this.runtime,
			content: item.content,
			scrubbedText,
			verdicts,
			rulesetVersion: item.rulesetVersion,
			jobId: item.jobId,
			itemRef: item.itemRef,
			tier0Only: !escalated,
			modelId,
			source: "piiScrubService",
		});
	}

	/** Emit FAILED + report the error after retries are exhausted. */
	private async emitFailure(
		item: PiiScrubQueueItem,
		error: Error,
	): Promise<void> {
		this.runtime.reportError("pii-scrub", error, {
			jobId: item.jobId,
			itemRef: item.itemRef,
			rulesetVersion: item.rulesetVersion,
		});
		await this.runtime.emitEvent(EventType.PII_SCRUB_FAILED, {
			runtime: this.runtime,
			content: item.content,
			rulesetVersion: item.rulesetVersion,
			jobId: item.jobId,
			itemRef: item.itemRef,
			error: error.message,
			source: "piiScrubService",
		});
	}

	async stop(): Promise<void> {
		this.runtime.logger.info(
			{ src: SRC, agentId: this.runtime.agentId },
			"Stopping PII scrub service",
		);
		if (this.isDisabled || !this.batchQueue) {
			return;
		}
		this.runtime.unregisterPipelineHook(MEMORY_HOOK_ID);
		const remaining = this.batchQueue.size;
		const fastShutdown = process.env.ELIZA_FAST_SHUTDOWN === "1";
		if (fastShutdown) {
			this.batchQueue.clear();
		}
		await this.batchQueue.dispose(this.runtime, {
			flushHighPriority: !fastShutdown,
		});
		this.runtime.logger.info(
			{ src: SRC, agentId: this.runtime.agentId, remainingItems: remaining },
			"Stopped",
		);
		this.batchQueue = null;
	}

	getQueueSize(): number {
		// After stop() the queue is gone by design; zero is the truthful answer,
		// not a masked failure.
		if (!this.batchQueue) return 0;
		return this.batchQueue.size;
	}

	getQueueStats(): {
		high: number;
		normal: number;
		low: number;
		total: number;
	} {
		return this.batchQueue?.stats() ?? { high: 0, normal: 0, low: 0, total: 0 };
	}

	clearQueue(): void {
		this.batchQueue?.clear();
	}

	/** Test/audit helper: read the done-marker for a piece of content. */
	async getMarker(content: string, rulesetVersion: string, itemRef?: string) {
		return getScrubMarker(this.runtime, content, rulesetVersion, itemRef);
	}
}

export default PiiScrubService;
