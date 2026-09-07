/** Owns embedding provider pinning, dimension initialization, and complete-memory embedding requests using the canonical runtime. */
import { ElizaError } from "../errors";
import {
	EventType,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type ModelTypeName,
	type UUID,
} from "../types";
import {
	NoModelProviderConfiguredError,
	type ResolvedModelRegistration,
} from "./model-dispatch/policy.js";

/** One failed TEXT_EMBEDDING dimension-probe attempt, kept for diagnostics. */
export interface EmbeddingProbeAttempt {
	provider: string;
	modelKey: string;
	error: string;
}

/** Providers that satisfy the app's explicit on-device embedding contract. */
export const LOCAL_EMBEDDING_PROVIDERS = new Set([
	"eliza-router",
	"eliza-local-inference",
	"eliza-device-bridge",
	"capacitor-llama",
	"eliza-aosp-llama",
]);

/**
 * Thrown by `AgentRuntime.ensureEmbeddingDimension` when EVERY registered
 * TEXT_EMBEDDING provider failed the null dimension probe. Carries the
 * per-provider failure list so callers (and logs) can show exactly which
 * providers were tried and why each one failed.
 *
 * `AgentRuntime.initialize` catches this error type — and only this type —
 * non-fatally: the runtime keeps booting with embedding generation disabled
 * (memory writes persist without vectors) instead of either crashing boot or
 * leaving the vector column at its default width, where later real vectors
 * would be silently dropped on dimension mismatch by the SQL adapter (#8769).
 */
export class EmbeddingDimensionProbeError extends Error {
	readonly attempts: readonly EmbeddingProbeAttempt[];
	constructor(attempts: readonly EmbeddingProbeAttempt[]) {
		const detail = attempts
			.map((attempt) => `${attempt.provider}: ${attempt.error}`)
			.join("; ");
		super(
			`All ${attempts.length} registered TEXT_EMBEDDING provider(s) failed the embedding dimension probe — ${detail}`,
		);
		this.name = "EmbeddingDimensionProbeError";
		this.attempts = attempts;
	}
}

export class RuntimeEmbeddings {
	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly host: {
			resolveModelRegistrations(
				modelType: ModelTypeName | string,
				provider?: string,
			): ResolvedModelRegistration[];
			fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch>;
		},
	) {}
	getPinnedProvider(): string | undefined {
		return this.pinnedEmbeddingProvider;
	}

	/**
	 * Provider that answered the boot-time TEXT_EMBEDDING dimension probe. The
	 * SQL adapter's vector column is sized from that provider's output, so all
	 * later embedding calls without an explicit provider are pinned to it —
	 * letting a different registration serve an embedding call can emit a
	 * different-width vector that the adapter silently drops on dimension
	 * mismatch (#8769). Re-set on every successful `ensureEmbeddingDimension`.
	 */
	private pinnedEmbeddingProvider: string | undefined;

	/**
	 * Non-null while embedding generation is disabled because every registered
	 * TEXT_EMBEDDING provider failed the dimension probe. While set, memory
	 * writes skip vector generation entirely (see `addEmbeddingToMemory` /
	 * `queueEmbeddingGeneration`) instead of producing vectors the SQL adapter
	 * would silently drop against a default-sized column. Cleared by the next
	 * successful `ensureEmbeddingDimension` (e.g. the deferred boot re-probe).
	 */
	private embeddingGenerationDisabledReason: string | null = null;

	/** Once-latch so the embedding-skip warning fires once, not per write. */
	private embeddingSkipWarned = false;

	/**
	 * True while embedding generation is disabled because every registered
	 * TEXT_EMBEDDING provider failed the dimension probe. While true, memory
	 * writes persist without vectors (recall over new memories is degraded)
	 * rather than emitting vectors the SQL adapter would silently drop against
	 * a default-sized column. Cleared by the next successful
	 * {@link ensureEmbeddingDimension} (e.g. the deferred boot re-probe).
	 */
	isEmbeddingGenerationDisabled(): boolean {
		return this.embeddingGenerationDisabledReason !== null;
	}

	disableEmbeddingGeneration(reason: string): void {
		this.embeddingGenerationDisabledReason = reason;
		this.embeddingSkipWarned = false;
	}

	enableEmbeddingGeneration(): void {
		if (this.embeddingGenerationDisabledReason !== null) {
			this.runtime.logger.info(
				{ src: "agent", agentId: this.runtime.agentId },
				"TEXT_EMBEDDING provider recovered; embedding generation re-enabled",
			);
		}
		this.embeddingGenerationDisabledReason = null;
		this.embeddingSkipWarned = false;
	}

	/**
	 * Once-latch warn for skipped embedding generation: the first skipped write
	 * logs a structured warning, subsequent skips stay quiet until the flag is
	 * cleared and re-set (a fresh degradation event warns again).
	 */
	warnEmbeddingGenerationSkipped(): void {
		if (this.embeddingSkipWarned) {
			return;
		}
		this.embeddingSkipWarned = true;
		this.runtime.logger.warn(
			{
				src: "agent",
				agentId: this.runtime.agentId,
				reason: this.embeddingGenerationDisabledReason,
			},
			"Embedding generation is disabled (every TEXT_EMBEDDING provider failed the dimension probe); memory writes are persisted WITHOUT vectors — recall over new memories is degraded until a provider recovers",
		);
	}

	async ensureEmbeddingDimension() {
		if (!this.runtime.adapter) {
			throw new Error(
				"Database adapter not initialized before ensureEmbeddingDimension",
			);
		}
		const canonicalProviderSetting = this.runtime.getSetting(
			"ELIZA_EMBEDDING_PROVIDER",
		);
		const embeddingProvider =
			typeof canonicalProviderSetting === "string" &&
			canonicalProviderSetting.trim()
				? canonicalProviderSetting.trim()
				: undefined;
		const allRegistrations = this.host.resolveModelRegistrations(
			ModelType.TEXT_EMBEDDING,
			embeddingProvider,
		);
		if (allRegistrations.length === 0) {
			throw new Error(
				embeddingProvider
					? `Configured TEXT_EMBEDDING provider "${embeddingProvider}" has no registered handler`
					: "No TEXT_EMBEDDING model registered",
			);
		}

		// EMBEDDING_PROVIDER=local is an ownership boundary, not a preference.
		// In particular, the dimension probe must not bypass the local router and
		// explicitly invoke cloud handlers: doing so caused clean local app boots
		// to send embedding batches to Eliza Cloud when the GGUF was still staging.
		// Prefer the router when present because it owns local device selection;
		// otherwise fail over only among concrete on-device handlers.
		const configuredOwnershipProvider = String(
			this.runtime.getSetting("EMBEDDING_PROVIDER") ?? "",
		)
			.trim()
			.toLowerCase();
		const localOnly = configuredOwnershipProvider === "local";
		const localRegistrations = localOnly
			? allRegistrations.filter((registration) =>
					LOCAL_EMBEDDING_PROVIDERS.has(registration.provider),
				)
			: [];
		const routerRegistrations = localRegistrations.filter(
			(registration) => registration.provider === "eliza-router",
		);
		const registrations = localOnly
			? routerRegistrations.length > 0
				? routerRegistrations
				: localRegistrations
			: allRegistrations;
		if (localOnly && registrations.length === 0) {
			const probeError = new EmbeddingDimensionProbeError([
				{
					provider: "local",
					modelKey: ModelType.TEXT_EMBEDDING,
					error:
						"EMBEDDING_PROVIDER=local but no on-device embedding handler is registered",
				},
			]);
			this.disableEmbeddingGeneration(probeError.message);
			throw probeError;
		}

		// Probe every eligible TEXT_EMBEDDING provider in the same priority order
		// useModel resolves them. An explicit local policy limits eligibility to
		// on-device handlers; it never falls through to a remote provider. The
		// probe passes null; handlers return a
		// zero-filled vector of their real output width. A provider that cannot
		// answer the null probe cannot produce usable vectors either, so ANY
		// probe failure — not just a rate limit — advances to the next
		// registration. First success wins: it sizes the adapter's vector column
		// and pins that provider for subsequent embedding calls, so the column
		// width and the vectors written to it always come from the same provider.
		const attempts: EmbeddingProbeAttempt[] = [];
		const probedProviders = new Set<string>();
		let allFailuresBenign = true;
		for (const registration of registrations) {
			if (probedProviders.has(registration.provider)) {
				continue;
			}
			probedProviders.add(registration.provider);

			let embedding: unknown;
			try {
				embedding = await this.runtime.useModel(
					ModelType.TEXT_EMBEDDING,
					null,
					registration.provider,
				);
			} catch (error) {
				// error-policy:J4 Probe each registered provider independently;
				// exhaustion throws EmbeddingDimensionProbeError below.
				if (!(error instanceof NoModelProviderConfiguredError)) {
					allFailuresBenign = false;
				}
				attempts.push({
					provider: registration.provider,
					modelKey: registration.modelKey,
					error: error instanceof Error ? error.message : String(error),
				});
				this.runtime.logger.warn(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						provider: registration.provider,
						error: error instanceof Error ? error.message : String(error),
					},
					localOnly
						? "Local TEXT_EMBEDDING provider failed the dimension probe; remote fallback is disabled"
						: "TEXT_EMBEDDING provider failed the dimension probe; trying next registered provider",
				);
				continue;
			}
			if (!Array.isArray(embedding) || embedding.length === 0) {
				allFailuresBenign = false;
				attempts.push({
					provider: registration.provider,
					modelKey: registration.modelKey,
					error: `Invalid embedding received (${Array.isArray(embedding) ? "empty array" : typeof embedding})`,
				});
				this.runtime.logger.warn(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						provider: registration.provider,
					},
					localOnly
						? "Local TEXT_EMBEDDING provider returned an invalid probe embedding; remote fallback is disabled"
						: "TEXT_EMBEDDING provider returned an invalid probe embedding; trying next registered provider",
				);
				continue;
			}

			await this.runtime.adapter.ensureEmbeddingDimension(embedding.length);
			this.pinnedEmbeddingProvider = registration.provider;
			this.enableEmbeddingGeneration();
			// Reclaim any vectors left in a different dimension column — e.g. cloud
			// 1536-dim embeddings after this agent switched to on-device gte-small
			// (384-dim) — which a same-width search can never match again, then
			// re-embed those memories at the active width. The clear is one quick
			// DELETE (a no-op once the store holds only active-dimension vectors);
			// the re-embed drains through the embedding queue in the background so
			// boot is never blocked on it.
			try {
				const staleMemoryIds =
					await this.runtime.adapter.clearEmbeddingsOutsideActiveDimension();
				if (staleMemoryIds.length > 0) {
					this.runtime.logger.info(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							count: staleMemoryIds.length,
							dimension: embedding.length,
						},
						"Reclaimed stale-dimension embeddings; re-embedding at active width",
					);
					void this.reembedMemoriesByIds(staleMemoryIds);
				}
			} catch (error) {
				// error-policy:J7 stale embedding reconciliation is best-effort maintenance; report and keep booting.
				this.runtime.reportError(
					"AgentRuntime.embeddingDimensionReconcile",
					error,
					{
						agentId: this.runtime.agentId,
					},
				);
			}
			this.runtime.logger.debug(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					dimension: embedding.length,
					provider: registration.provider,
					failedProviders: attempts.map((attempt) => attempt.provider),
				},
				"Embedding dimension set",
			);
			return;
		}

		// Every registered handler reported "no backing provider configured"
		// (e.g. a cloud proxy handler before login). Nothing can emit vectors,
		// so a default-width column cannot cause a dimension mismatch — keep the
		// long-standing benign skip.
		if (allFailuresBenign) {
			this.runtime.logger.warn(
				{ src: "agent", agentId: this.runtime.agentId },
				"No backing TEXT_EMBEDDING provider registered, skipping embedding setup",
			);
			return;
		}

		// All probes failed for real. Disable embedding generation so memory
		// writes skip vector generation coherently (no silent drops downstream),
		// and surface a typed error carrying every provider's failure.
		const probeError = new EmbeddingDimensionProbeError(attempts);
		this.disableEmbeddingGeneration(probeError.message);
		throw probeError;
	}

	async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
		if (Array.isArray(memory.embedding) && memory.embedding.length > 0) {
			return memory;
		}
		const memoryText = memory.content.text;
		if (!memoryText) {
			throw new Error("Cannot generate embedding: Memory content is empty");
		}
		if (this.embeddingGenerationDisabledReason !== null) {
			// Every TEXT_EMBEDDING provider failed the dimension probe, so the
			// vector column was never sized for this runtime. Skip generation
			// explicitly (warn once) instead of producing a vector the SQL
			// adapter would silently drop on dimension mismatch (#8769).
			this.warnEmbeddingGenerationSkipped();
			return memory;
		}
		const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: memoryText,
		});
		if (!Array.isArray(embedding) || embedding.length === 0) {
			throw new ElizaError(
				"TEXT_EMBEDDING provider returned no usable vector",
				{
					code: "EMBEDDING_MODEL_OUTPUT_INVALID",
					context: {
						memoryId: memory.id,
						outputKind: Array.isArray(embedding)
							? "empty-array"
							: typeof embedding,
					},
					severity: "fatal",
				},
			);
		}
		memory.embedding = embedding;
		return memory;
	}

	/**
	 * Re-embed the given memories at the active embedding dimension after their
	 * stale-dimension vectors were reclaimed. Runs detached from boot and drains
	 * through the embedding queue at `low` priority so live traffic is never
	 * starved. Fetched in chunks so a large migration never loads every memory at
	 * once; a chunk failure is reported and the rest still proceed.
	 */
	async reembedMemoriesByIds(memoryIds: UUID[]): Promise<void> {
		const CHUNK = 200;
		for (let i = 0; i < memoryIds.length; i += CHUNK) {
			try {
				const memories = await this.runtime.adapter.getMemoriesByIds(
					memoryIds.slice(i, i + CHUNK),
				);
				for (const memory of memories) {
					await this.queueEmbeddingGeneration(memory, "low");
				}
			} catch (error) {
				// error-policy:J7 stale embedding requeue is best-effort maintenance; report and continue later chunks.
				this.runtime.reportError("AgentRuntime.reembedMemoriesByIds", error, {
					agentId: this.runtime.agentId,
				});
			}
		}
	}

	/**
	 * Queue a memory for embedding generation. If companionUrl is set, POSTs to companion
	 * and returns without waiting (fire-and-forget). WHY: Thin runtime doesn't block on embedding.
	 */
	async queueEmbeddingGeneration(
		memory: Memory,
		priority?: "high" | "normal" | "low",
	): Promise<void> {
		priority = priority || "normal";
		if (
			!memory ||
			(Array.isArray(memory.embedding) && memory.embedding.length > 0) ||
			!memory.content.text
		) {
			return;
		}
		if (this.embeddingGenerationDisabledReason !== null) {
			// See addEmbeddingToMemory: no provider passed the dimension probe,
			// so queueing would only produce per-item generation failures (or
			// silently dropped vectors). Skip explicitly, warn once.
			this.warnEmbeddingGenerationSkipped();
			return;
		}

		if (this.runtime.companionUrl) {
			const url = `${this.runtime.companionUrl.replace(/\/$/, "")}/embedding-generation`;
			void this.host
				.fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						agentId: this.runtime.agentId,
						memory,
						priority,
						runId: this.runtime.getCurrentRunId(),
					}),
				})
				.catch((err) =>
					// error-policy:J7 diagnostics-must-not-kill-the-loop — offloading
					// embedding generation to the companion is fire-and-forget, but a
					// dead companion must surface (embeddings would silently stop).
					this.runtime.reportError("AgentRuntime.companionEmbedding", err, {
						url,
						agentId: this.runtime.agentId,
					}),
				);
			return;
		}

		void this.runtime
			.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime: this.runtime,
				memory,
				priority,
				source: "runtime",
				retryCount: 0,
				maxRetries: 3,
				runId: this.runtime.getCurrentRunId(),
			})
			.catch((error) => {
				// error-policy:J7 The asynchronous request must surface even though
				// it cannot block the memory write that scheduled it.
				this.runtime.logger.warn(
					{
						src: "runtime",
						error: error instanceof Error ? error.message : String(error),
						memoryId: memory.id,
						priority,
					},
					"Embedding generation request failed",
				);
				this.runtime.reportError(
					"AgentRuntime.embeddingGenerationRequest",
					error,
					{
						memoryId: memory.id,
						priority,
					},
				);
			});
	}

	clearEmbeddingsOutsideActiveDimension(): Promise<UUID[]> {
		return this.runtime.adapter.clearEmbeddingsOutsideActiveDimension();
	}

	async getCachedEmbeddings(params: {
		query_table_name: string;
		query_threshold: number;
		query_input: string;
		query_field_name: string;
		query_field_sub_name: string;
		query_match_count: number;
	}): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
		return this.runtime.adapter.getCachedEmbeddings(params);
	}
}
