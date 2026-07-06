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
 *   1. Computes the content-addressed done-marker
 *      `pii:<sha256(content)>:v<rulesetVersion>` and SKIPS if already present
 *      (idempotency: a re-scrub of unchanged content is a no-op - zero model
 *      calls, zero duplicate writes). This is what makes crash-and-rerun safe
 *      with zero cursor state.
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
 * When no `PII_SCRUB` model is registered the service still starts (tier-0-only
 * content - fully-covered structured PII - completes without a model), matching
 * the embedding service's "start even when no model" behavior; content with
 * un-inspectable residue then fails-closed at the seam, as intended.
 *
 * OUT OF SCOPE for this service (sibling issues / later slices): the CLOUD lane
 * (routing/resolve/jobsRepository/Redis+cron), the scrub prompt/semantics, and
 * the model seam itself (already merged).
 */

import {
	getScrubMarker,
	isScrubDone,
	markScrubDone,
} from "../security/pii-scrub-markers.js";
import {
	PiiScrubFabricationError,
	scrubWithEscalation,
} from "../security/pii-scrub-seam.js";
import type { PiiScrubRequestPayload } from "../types/events.js";
import { EventType } from "../types/events.js";
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
	itemRef?: string;
}

const SRC = "plugin:basic-capabilities:service:pii-scrub";

/**
 * Service responsible for running the corpus PII scrub asynchronously on the
 * core task queue. Mirrors {@link EmbeddingGenerationService}.
 */
export class PiiScrubService extends Service {
	static serviceType = "pii-scrub";
	capabilityDescription =
		"Runs the corpus PII scrub asynchronously on the core task queue (content-hash idempotent, non-blocking)";

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

		// Same drain/retry/priority model as the embedding service - the task
		// system owns WHEN (repeat PII_SCRUB_DRAIN tick), we own WHAT (dequeue,
		// escalate, mark-done). No maxSize: the bottleneck is model I/O, not
		// queue length. No processBatch: the seam is a per-item escalation with
		// per-item content-addressed idempotency, so there is no single-call
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

		// Cheap pre-enqueue idempotency: if this exact content+ruleset is already
		// scrubbed, do not even queue it. The drain re-checks under the hood so a
		// race (two enqueues of the same content) still no-ops, but this avoids
		// the queue churn for the common re-scrub case.
		if (await isScrubDone(this.runtime, content, payload.rulesetVersion)) {
			this.runtime.logger.debug(
				{ src: SRC, agentId: this.runtime.agentId, itemRef: payload.itemRef },
				"Content already scrubbed under this ruleset, skipping enqueue",
			);
			return;
		}

		const item: PiiScrubQueueItem = {
			content,
			rulesetVersion: payload.rulesetVersion,
			candidateSpans: payload.candidateSpans ?? [],
			contextPack: payload.contextPack,
			pseudonymAssignments: payload.pseudonymAssignments,
			priority: payload.priority ?? "low",
			inferencePriority: payload.inferencePriority ?? "background",
			jobId: payload.jobId,
			itemRef: payload.itemRef,
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
		if (await isScrubDone(this.runtime, item.content, item.rulesetVersion)) {
			this.runtime.logger.debug(
				{ src: SRC, agentId: this.runtime.agentId, itemRef: item.itemRef },
				"Item already scrubbed (drain-time idempotency hit), skipping",
			);
			return;
		}

		let escalated: boolean;
		let modelId: string;
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
		} catch (error) {
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

		// Success: write the content-addressed done-marker so a re-scrub of this
		// exact content under this ruleset no-ops, and a crash-restart resumes
		// past it with zero duplicate work.
		await markScrubDone(this.runtime, item.content, {
			rulesetVersion: item.rulesetVersion,
			modelId,
			tier0Only: !escalated,
		});

		await this.runtime.emitEvent(EventType.PII_SCRUB_COMPLETED, {
			runtime: this.runtime,
			content: item.content,
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
		try {
			this.runtime.reportError("pii-scrub", error, {
				jobId: item.jobId,
				itemRef: item.itemRef,
				rulesetVersion: item.rulesetVersion,
			});
		} catch (reportError) {
			// reportError is best-effort; never let it mask the failure event.
			this.runtime.logger.warn(
				{
					src: SRC,
					agentId: this.runtime.agentId,
					itemRef: item.itemRef,
					error:
						reportError instanceof Error
							? reportError.message
							: String(reportError),
				},
				"Failed to report exhausted PII scrub error",
			);
		}
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
		return this.batchQueue?.size ?? 0;
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
	async getMarker(content: string, rulesetVersion: string) {
		return getScrubMarker(this.runtime, content, rulesetVersion);
	}
}

export default PiiScrubService;
