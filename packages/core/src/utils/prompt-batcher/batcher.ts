import type { Memory } from "../../types/memory";
import type { GenerateTextParams } from "../../types/model";
import {
	BatcherDisposedError,
	type BatcherResult,
	type BatcherStats,
	type ContextResolver,
	type DrainLog,
	type DrainMeta,
	type PreCallbackHandler,
	type PromptSection,
	type ResolvedSection,
} from "../../types/prompt-batcher";
import type { IAgentRuntime } from "../../types/runtime";
import type { SchemaRow } from "../../types/state";
import { TaskDrain } from "../batch-queue";
import type { PromptDispatcher } from "./dispatcher";
import {
	buildCharacterContext,
	type CacheEntry,
	clampRetryCount,
	createMinimalState,
	type Deferred,
	type DispatchCallMeta,
	getSourceMessageId,
	hasMeaningfulSectionDrift,
	type PendingResult,
	type PromptBatcherSettings,
	rollingAverage,
	sanitizeIdentifier,
} from "./shared";

export class PromptBatcher {
	private readonly sections = new Map<string, PromptSection>();
	private readonly pendingResults = new Map<string, PendingResult>();
	private readonly contextResolvers = new Map<string, ContextResolver>();
	private readonly preCallbackHandlers = new Map<string, PreCallbackHandler>();
	private readonly messageBuffers = new Map<string, Memory[]>();
	private readonly processedMessageIds = new Set<string>();
	private readonly processedMessageOrder: string[] = [];
	private readonly affinityLocks = new Map<string, Promise<void>>();
	private readonly lastRunAt = new Map<string, number>();
	private readonly inMemoryCache = new Map<string, CacheEntry>();
	private readonly stats: BatcherStats = {
		totalDrains: 0,
		totalCalls: 0,
		totalCacheHits: 0,
		totalFallbacks: 0,
		avgSectionsPerCall: 0,
		avgDrainDurationMs: 0,
	};

	private enabled = false;
	private disposed = false;
	private readonly affinityDrains = new Map<string, TaskDrain>();

	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly dispatcher: PromptDispatcher,
		private readonly settings: PromptBatcherSettings,
	) {
		void this.runtime.initPromise.then(() => {
			if (!this.disposed) {
				this.enabled = true;
				void this.drain();
			}
		});
	}

	/**
	 * Register a section and return a promise that resolves when the section is first
	 * delivered (or null if the section ID already existed). Resolves with BatcherResult
	 * so callers get { fields, meta }. WHY: Thenable API lets consumers await or .then()
	 * instead of relying only on onResult callbacks; meta carries drain context (fallbackUsed, etc.).
	 */
	addSection(section: PromptSection): Promise<BatcherResult | null> {
		if (this.disposed) {
			return Promise.reject(new BatcherDisposedError());
		}

		this._validateProviders(section.providers);
		const existing = this.sections.get(section.id);
		if (existing) {
			if (hasMeaningfulSectionDrift(existing, section)) {
				this.runtime.logger.warn(
					{
						src: "prompt-batcher",
						agentId: this.runtime.agentId,
						sectionId: section.id,
					},
					"Duplicate prompt section ID registered with different configuration",
				);
			}
			return Promise.resolve(null);
		}

		const normalized: PromptSection = {
			...section,
			priority: section.priority ?? "normal",
			model: section.model ?? "small",
			isolated: section.isolated ?? false,
			affinityKey: section.affinityKey ?? "default",
			maxRetries: clampRetryCount(section.maxRetries),
		};
		this.sections.set(normalized.id, normalized);

		const deferred = {} as Deferred<BatcherResult | null>;
		const promise = new Promise<BatcherResult | null>((resolve, reject) => {
			deferred.resolve = resolve;
			deferred.reject = reject;
		});
		this.pendingResults.set(normalized.id, {
			deferred,
			resolved: false,
		});

		const affinityKey = normalized.affinityKey ?? "default";
		void this._ensureAffinityDrain(affinityKey)
			.then(() => this._syncAffinityTask(affinityKey))
			.catch((error) => {
				this.runtime.logger.error(
					{
						src: "prompt-batcher",
						agentId: this.runtime.agentId,
						affinityKey,
						error,
					},
					"Failed to ensure prompt batcher drain",
				);
			});

		const shouldDrainNow =
			normalized.priority === "immediate" ||
			normalized.frequency === "once" ||
			normalized.frequency === "per-drain";

		if (shouldDrainNow) {
			if (this.enabled) {
				void this.drainAffinityGroup(normalized.affinityKey ?? "default");
			} else if (
				normalized.priority === "immediate" ||
				normalized.frequency === "once"
			) {
				// WHY: `enabled` flips true only after initPromise; without this, askNow
				// registered during early startup would never drain until a later global drain.
				// Per-drain sections intentionally skip this path so they are not double-drained.
				void this.runtime.initPromise.then(() => {
					if (!this.disposed) {
						void this.drainAffinityGroup(normalized.affinityKey ?? "default");
					}
				});
			}
		}

		return promise;
	}

	removeSection(id: string): void {
		const section = this.sections.get(id);
		const affinityKey = section?.affinityKey ?? "default";
		this.sections.delete(id);
		this.pendingResults.delete(id);
		this.lastRunAt.delete(id);
		if (this.getSectionCountForAffinity(affinityKey) === 0) {
			void this._removeAffinityTask(affinityKey);
		} else {
			void this._syncAffinityTask(affinityKey);
		}
	}

	registerContextResolver(slug: string, resolver: ContextResolver): void {
		if (this.contextResolvers.has(slug)) {
			this.runtime.logger.warn(
				{
					src: "prompt-batcher",
					agentId: this.runtime.agentId,
					slug,
				},
				"Prompt batcher context resolver already registered; keeping first value",
			);
			return;
		}

		this.contextResolvers.set(slug, resolver);
	}

	registerPreCallbackHandler(handler: PreCallbackHandler): void {
		if (this.preCallbackHandlers.has(handler.id)) {
			this.runtime.logger.warn(
				{
					src: "prompt-batcher",
					agentId: this.runtime.agentId,
					handlerId: handler.id,
				},
				"Prompt batcher pre-callback handler already registered",
			);
			return;
		}

		this.preCallbackHandlers.set(handler.id, handler);
	}

	getPreCallbackHandlers(actionName: string): PreCallbackHandler[] {
		return Array.from(this.preCallbackHandlers.values()).filter((handler) =>
			handler.actionFilter.includes(actionName),
		);
	}

	/**
	 * Buffer a message for batching and optionally trigger drains for message-relevant affinities (default, room:X, audit:X).
	 * No-arg tick() is a no-op. WHY: no background timer; only message cadence or task-driven drains run. Autonomy is not drained here (task-driven only).
	 */
	tick(message?: Memory): void {
		if (this.disposed) return;
		if (!message) return;

		const sourceMessageId = getSourceMessageId(message);
		if (this.processedMessageIds.has(sourceMessageId)) return;

		this.processedMessageIds.add(sourceMessageId);
		this.processedMessageOrder.push(sourceMessageId);
		if (this.processedMessageOrder.length > 1000) {
			const oldest = this.processedMessageOrder.shift();
			if (oldest) this.processedMessageIds.delete(oldest);
		}

		this._pushMessage("default", message);
		this._pushMessage(`room:${String(message.roomId)}`, message);
		this._pushMessage(`audit:${String(message.roomId)}`, message);
		this._pushMessage("autonomy", message);

		const messageAffinities = [
			"default",
			`room:${String(message.roomId)}`,
			`audit:${String(message.roomId)}`,
		];
		for (const affinityKey of messageAffinities) {
			if (this._shouldDrainAffinity(affinityKey)) {
				void this.drainAffinityGroup(affinityKey);
			}
		}
	}

	private _shouldDrainAffinity(affinityKey: string): boolean {
		if (!this.enabled) return false;
		const sections = Array.from(this.sections.values()).filter(
			(s) => (s.affinityKey ?? "default") === affinityKey,
		);
		if (sections.some((s) => s.priority === "immediate")) return true;
		const buffer = this.messageBuffers.get(affinityKey) ?? [];
		return buffer.length >= this.settings.batchSize;
	}

	async drain(): Promise<void> {
		if (this.disposed || !this.enabled) {
			return;
		}

		const affinityKeys = this._getActiveAffinityKeys();
		await Promise.allSettled(
			affinityKeys.map((affinityKey) => this.drainAffinityGroup(affinityKey)),
		);
	}

	dispose(): void {
		this.disposed = true;

		for (const [, drain] of this.affinityDrains) {
			void drain.dispose(this.runtime).catch(() => {
				/* task may already be gone */
			});
		}
		this.affinityDrains.clear();

		for (const pending of this.pendingResults.values()) {
			if (!pending.resolved) {
				pending.resolved = true; // WHY: So a late _deliverSectionResult never resolves the same deferred.
				pending.deferred.reject(new BatcherDisposedError());
			}
		}

		this.pendingResults.clear();
		this.sections.clear();
		this.messageBuffers.clear();
		this.affinityLocks.clear();
	}

	invalidateCache(sectionId: string): void {
		const cacheKey = this._cacheKey(sectionId);
		this.inMemoryCache.delete(cacheKey);
		void this.runtime.deleteCache(cacheKey);
	}

	invalidateAllCaches(): void {
		for (const section of this.sections.values()) {
			this.invalidateCache(section.id);
		}
	}

	getStats(): BatcherStats {
		return { ...this.stats };
	}

	askOnce(
		id: string,
		opts: {
			preamble: string;
			schema: SchemaRow[];
			fallback?: Record<string, unknown>;
			providers?: string[];
			model?: "small" | "large";
			cacheTtlMs?: number;
			staleWhileRevalidate?: boolean;
			forceRegenerate?: boolean;
			shouldRun?: (runtime: IAgentRuntime) => Promise<boolean> | boolean;
			validate?: (
				fields: Record<string, unknown>,
			) => Record<string, unknown> | null;
			maxRetries?: number;
			execOptions?: {
				temperature?: number;
				maxTokens?: number;
				stopSequences?: string[];
			};
		},
	): Promise<Record<string, unknown>> {
		return this.addSection({
			id,
			frequency: "once",
			priority: "background",
			affinityKey: "init",
			preamble: opts.preamble,
			schema: opts.schema,
			fallback: this._normalizeFallback(opts.fallback),
			providers: opts.providers,
			model: opts.model,
			cacheTtlMs: opts.cacheTtlMs,
			staleWhileRevalidate: opts.staleWhileRevalidate,
			forceRegenerate: opts.forceRegenerate,
			shouldRun: opts.shouldRun,
			validate: opts.validate,
			maxRetries: opts.maxRetries,
			execOptions: opts.execOptions,
		}).then((result) => result?.fields ?? {}); // WHY: Unwrap so callers still get Record, not BatcherResult.
	}

	/**
	 * Register a per-drain section and return a promise of the first result. Resolves with
	 * { fields, meta } or null (duplicate ID). onResult is optional; when provided, it is
	 * still invoked so fire-and-forget or recurring use (e.g. think()) is unchanged.
	 * WHY: Linear await + if (result) { ... } is easier than a large onResult callback;
	 * generic T lets callers get typed result.fields without casting.
	 */
	onDrain<T = Record<string, unknown>>(
		id: string,
		opts: {
			preamble: string;
			schema: SchemaRow[];
			onResult?: (
				fields: Record<string, unknown>,
				meta: DrainMeta,
			) => void | Promise<void>;
			fallback?: Record<string, unknown>;
			providers?: string[];
			model?: "small" | "large";
			room?: string;
			shouldRun?: (runtime: IAgentRuntime) => Promise<boolean> | boolean;
			validate?: (
				fields: Record<string, unknown>,
			) => Record<string, unknown> | null;
			maxRetries?: number;
			execOptions?: {
				temperature?: number;
				maxTokens?: number;
				stopSequences?: string[];
			};
		},
	): Promise<BatcherResult<T> | null> {
		return this.addSection({
			id,
			frequency: "per-drain",
			priority: "normal",
			affinityKey: opts.room ? `room:${opts.room}` : "default",
			preamble: opts.preamble,
			schema: opts.schema,
			onResult: opts.onResult,
			fallback: this._normalizeFallback(opts.fallback),
			providers: opts.providers,
			model: opts.model,
			shouldRun: opts.shouldRun,
			validate: opts.validate,
			maxRetries: opts.maxRetries,
			execOptions: opts.execOptions,
		}) as Promise<BatcherResult<T> | null>; // WHY: addSection returns BatcherResult; caller's T is trusted for typing only.
	}

	think(
		id: string,
		opts: {
			contextBuilder: (
				runtime: IAgentRuntime,
				messages: Memory[],
			) => Promise<string> | string;
			preamble: string;
			schema: SchemaRow[];
			onResult: (
				fields: Record<string, unknown>,
				meta: DrainMeta,
			) => void | Promise<void>;
			fallback?: Record<string, unknown>;
			minCycleMs?: number;
			model?: "small" | "large";
			shouldRun?: (runtime: IAgentRuntime) => Promise<boolean> | boolean;
			validate?: (
				fields: Record<string, unknown>,
			) => Record<string, unknown> | null;
			maxRetries?: number;
			execOptions?: {
				temperature?: number;
				maxTokens?: number;
				stopSequences?: string[];
			};
		},
	): void {
		void this.addSection({
			id,
			frequency: "recurring",
			priority: "normal",
			affinityKey: "autonomy",
			contextBuilder: opts.contextBuilder,
			preamble: opts.preamble,
			schema: opts.schema,
			onResult: opts.onResult,
			fallback: this._normalizeFallback(opts.fallback),
			minCycleMs: opts.minCycleMs,
			model: opts.model,
			shouldRun: opts.shouldRun,
			validate: opts.validate,
			maxRetries: opts.maxRetries,
			execOptions: opts.execOptions,
		});
	}

	askNow(
		id: string,
		opts: {
			preamble: string;
			schema: SchemaRow[];
			fallback: Record<string, unknown>;
			providers?: string[];
			model?: "small" | "large";
			room?: string;
			validate?: (
				fields: Record<string, unknown>,
			) => Record<string, unknown> | null;
			maxRetries?: number;
			execOptions?: {
				temperature?: number;
				maxTokens?: number;
				stopSequences?: string[];
			};
		},
	): Promise<Record<string, unknown>> {
		return this.addSection({
			id,
			frequency: "once",
			priority: "immediate",
			affinityKey: opts.room ? `room:${opts.room}` : "default",
			preamble: opts.preamble,
			schema: opts.schema,
			fallback: this._normalizeFallback(opts.fallback),
			providers: opts.providers,
			model: opts.model,
			validate: opts.validate,
			maxRetries: opts.maxRetries,
			execOptions: opts.execOptions,
		}).then((result) => result?.fields ?? opts.fallback); // WHY: Unwrap so callers get Record, not BatcherResult; fallback required by signature.
	}

	private _pushMessage(key: string, message: Memory): void {
		const buffer = this.messageBuffers.get(key) ?? [];
		buffer.push(message);
		const maxBufferedMessages = Math.max(this.settings.batchSize * 4, 50);
		if (buffer.length > maxBufferedMessages) {
			buffer.splice(0, buffer.length - maxBufferedMessages);
		}
		this.messageBuffers.set(key, buffer);
	}

	private _getActiveAffinityKeys(): string[] {
		const keys = new Set<string>();
		for (const section of this.sections.values()) {
			keys.add(section.affinityKey ?? "default");
		}
		return Array.from(keys);
	}

	/**
	 * Returns the ideal tick interval for an affinity group: min of recurring sections' minCycleMs,
	 * capped by maxDrainIntervalMs. If no recurring sections, returns maxDrainIntervalMs.
	 */
	getIdealTickInterval(affinityKey: string): number {
		const sections = Array.from(this.sections.values()).filter(
			(s) => (s.affinityKey ?? "default") === affinityKey,
		);
		let minInterval = this.settings.maxDrainIntervalMs;
		for (const section of sections) {
			if (
				section.frequency === "recurring" &&
				typeof section.minCycleMs === "number" &&
				section.minCycleMs > 0
			) {
				minInterval = Math.min(minInterval, section.minCycleMs);
			}
		}
		return Math.min(minInterval, this.settings.maxDrainIntervalMs);
	}

	/** Returns the number of sections with the given affinity key. */
	getSectionCountForAffinity(affinityKey: string): number {
		return Array.from(this.sections.values()).filter(
			(s) => (s.affinityKey ?? "default") === affinityKey,
		).length;
	}

	/**
	 * One repeat task per affinity — shared {@link TaskDrain} with `skipRegisterWorker`:
	 * TaskService already registers `BATCHER_DRAIN`; we only ensure the DB row + interval updates.
	 * Same subsystem as embedding drains (`utils/batch-queue.ts` rationale).
	 */
	private async _ensureAffinityDrain(affinityKey: string): Promise<void> {
		if (this.affinityDrains.has(affinityKey)) {
			return;
		}
		if (
			typeof this.runtime.getTasksByName !== "function" ||
			typeof this.runtime.createTask !== "function"
		) {
			return;
		}
		const interval = this.getIdealTickInterval(affinityKey);
		const drain = new TaskDrain(
			{
				taskName: "BATCHER_DRAIN",
				description: `Drain affinity group: ${affinityKey}`,
				intervalMs: interval,
				taskMetadata: { affinityKey },
				skipRegisterWorker: true,
			},
			interval,
		);
		await drain.start(this.runtime);
		this.affinityDrains.set(affinityKey, drain);
	}

	private async _syncAffinityTask(affinityKey: string): Promise<void> {
		const drain = this.affinityDrains.get(affinityKey);
		if (!drain) return;
		const count = this.getSectionCountForAffinity(affinityKey);
		if (count === 0) {
			await this._removeAffinityTask(affinityKey);
			return;
		}
		const newInterval = this.getIdealTickInterval(affinityKey);
		await drain.updateInterval(this.runtime, newInterval);
	}

	private async _removeAffinityTask(affinityKey: string): Promise<void> {
		const drain = this.affinityDrains.get(affinityKey);
		if (!drain) return;
		try {
			await drain.dispose(this.runtime);
		} finally {
			this.affinityDrains.delete(affinityKey);
		}
	}

	async drainAffinityGroup(affinityKey: string): Promise<void> {
		const existingLock = this.affinityLocks.get(affinityKey);
		if (existingLock) {
			await existingLock;
		}

		let release!: () => void;
		const lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.affinityLocks.set(affinityKey, lock);

		try {
			await this._drainAffinityGroupUnlocked(affinityKey);
		} finally {
			release();
			this.affinityLocks.delete(affinityKey);
		}
	}

	private async _drainAffinityGroupUnlocked(
		affinityKey: string,
	): Promise<void> {
		if (this.disposed || !this.enabled) {
			return;
		}

		const drainStartedAt = Date.now();
		const sections = Array.from(this.sections.values()).filter(
			(section) => (section.affinityKey ?? "default") === affinityKey,
		);
		if (sections.length === 0) {
			return;
		}

		const messages = this._getMessagesForAffinity(affinityKey);
		const drainId = `${sanitizeIdentifier(affinityKey)}-${drainStartedAt}`;
		const sectionsIncluded: string[] = [];
		const sectionsSkipped: string[] = [];
		const cacheHits: string[] = [];
		const allCalls: DispatchCallMeta[] = [];

		const firstPass = sections.filter(
			(section) => !section.dependsOnEvaluators,
		);
		const secondPass = sections.filter(
			(section) => section.dependsOnEvaluators,
		);

		allCalls.push(
			...(await this._runDrainPass({
				drainId,
				affinityKey,
				messages,
				sections: firstPass,
				sectionsIncluded,
				sectionsSkipped,
				cacheHits,
			})),
		);

		if (secondPass.length > 0) {
			const secondPassMessages = this._getMessagesForAffinity(affinityKey);
			allCalls.push(
				...(await this._runDrainPass({
					drainId,
					affinityKey,
					messages: secondPassMessages,
					sections: secondPass,
					sectionsIncluded,
					sectionsSkipped,
					cacheHits,
				})),
			);
		}

		this.stats.totalDrains += 1;
		this.stats.avgDrainDurationMs = rollingAverage(
			this.stats.avgDrainDurationMs,
			this.stats.totalDrains,
			Date.now() - drainStartedAt,
		);

		if (messages.length > 0) {
			this.messageBuffers.set(affinityKey, []);
		}

		this._emitDrainLog({
			drainId,
			agentId: String(this.runtime.agentId),
			affinityKey,
			timestamp: drainStartedAt,
			durationMs: Date.now() - drainStartedAt,
			sectionsIncluded,
			sectionsSkipped,
			cacheHits,
			callCount: allCalls.length,
			calls: allCalls,
		});
	}

	private async _runDrainPass(args: {
		drainId: string;
		affinityKey: string;
		messages: Memory[];
		sections: PromptSection[];
		sectionsIncluded: string[];
		sectionsSkipped: string[];
		cacheHits: string[];
	}): Promise<DispatchCallMeta[]> {
		const resolverCache = new Map<string, string>();
		const active: ResolvedSection[] = [];
		const now = Date.now();

		for (const section of args.sections) {
			if (section.frequency === "per-drain" && args.messages.length === 0) {
				args.sectionsSkipped.push(section.id);
				continue;
			}

			if (section.shouldRun) {
				try {
					const shouldRun = await section.shouldRun(this.runtime);
					if (!shouldRun) {
						args.sectionsSkipped.push(section.id);
						continue;
					}
				} catch (error) {
					this.runtime.logger.warn(
						{
							src: "prompt-batcher",
							agentId: this.runtime.agentId,
							sectionId: section.id,
							error,
						},
						"Prompt batcher shouldRun threw; skipping section",
					);
					args.sectionsSkipped.push(section.id);
					continue;
				}
			}

			const cacheState = await this._checkCache(section);
			if (cacheState.hit && cacheState.fields) {
				const validatedCached = this._runValidate(section, cacheState.fields);
				if (validatedCached) {
					this.stats.totalCacheHits += 1;
					args.cacheHits.push(section.id);
					await this._deliverSectionResult({
						section,
						fields: validatedCached,
						meta: {
							drainId: args.drainId,
							timestamp: now,
							messages: args.messages,
							sectionId: section.id,
							actualModel: section.model ?? "small",
							durationMs: 0,
							cacheHit: true,
							staleRevalidation: cacheState.stale,
							packedWith: [],
							retryAttempt: 0,
							fallbackUsed: false,
						},
						removeOnceSection: !cacheState.stale,
					});

					if (!cacheState.stale) {
						continue;
					}
				} else {
					this.invalidateCache(section.id);
				}
			}

			const resolved = await this._resolveContext(
				section,
				args.messages,
				resolverCache,
			);
			if (!resolved) {
				args.sectionsSkipped.push(section.id);
				continue;
			}

			args.sectionsIncluded.push(section.id);
			active.push(resolved);
		}

		if (active.length === 0) {
			return [];
		}

		const outcome = await this.dispatcher.dispatch(active, this.runtime);
		this.stats.totalCalls += outcome.calls.length;
		this.stats.avgSectionsPerCall = rollingAverage(
			this.stats.avgSectionsPerCall,
			this.stats.totalCalls,
			outcome.calls.reduce((sum, call) => sum + call.sectionIds.length, 0) /
				Math.max(1, outcome.calls.length),
		);

		const retriedCallIds = new Set<string>();
		await Promise.allSettled(
			active.map(async (resolvedSection) => {
				const baseMeta = this._metaForSection(
					resolvedSection,
					args.drainId,
					args.messages,
					outcome.calls,
				);

				const rawFields = outcome.results.get(resolvedSection.section.id);
				if (!rawFields) {
					const fallback = this._fallbackForSection(resolvedSection.section);
					await this._deliverSectionResult({
						section: resolvedSection.section,
						fields: fallback,
						meta: { ...baseMeta, fallbackUsed: true },
						removeOnceSection: true,
					});
					return;
				}

				const validated = this._runValidate(resolvedSection.section, rawFields);
				if (validated) {
					await this._writeCache(resolvedSection.section, validated);
					await this._deliverSectionResult({
						section: resolvedSection.section,
						fields: validated,
						meta: baseMeta,
						removeOnceSection: true,
					});
					this.lastRunAt.set(resolvedSection.section.id, Date.now());
					return;
				}

				const retryFields = await this._retrySection(
					resolvedSection,
					args.messages,
					1,
					retriedCallIds,
				);
				if (retryFields) {
					await this._writeCache(resolvedSection.section, retryFields);
					await this._deliverSectionResult({
						section: resolvedSection.section,
						fields: retryFields,
						meta: { ...baseMeta, retryAttempt: 1 },
						removeOnceSection: true,
					});
					this.lastRunAt.set(resolvedSection.section.id, Date.now());
					return;
				}

				const fallback = this._fallbackForSection(resolvedSection.section);
				await this._deliverSectionResult({
					section: resolvedSection.section,
					fields: fallback,
					meta: { ...baseMeta, fallbackUsed: true },
					removeOnceSection: true,
				});
			}),
		);

		if (retriedCallIds.size > 0) {
			outcome.calls.push({
				model: "small",
				sectionIds: Array.from(retriedCallIds),
				estimatedTokens: 0,
				durationMs: 0,
				success: true,
				retried: true,
				fallbackUsed: [],
			});
		}

		return outcome.calls;
	}

	private _metaForSection(
		section: ResolvedSection,
		drainId: string,
		messages: Memory[],
		calls: DispatchCallMeta[],
	): DrainMeta {
		const call = calls.find((item) =>
			item.sectionIds.includes(section.section.id),
		);
		return {
			drainId,
			timestamp: Date.now(),
			messages,
			sectionId: section.section.id,
			actualModel: call?.model ?? section.preferredModel,
			durationMs: call?.durationMs ?? 0,
			cacheHit: false,
			staleRevalidation: false,
			packedWith: (call?.sectionIds ?? []).filter(
				(id) => id !== section.section.id,
			),
			retryAttempt: 0,
			fallbackUsed: false,
		};
	}

	private async _resolveContext(
		section: PromptSection,
		messages: Memory[],
		resolverCache: Map<string, string>,
	): Promise<ResolvedSection | null> {
		const pieces: string[] = [];
		const providers = section.providers ?? [];
		const anchorMessage = messages[messages.length - 1];

		if (providers.length === 0) {
			pieces.push(buildCharacterContext(this.runtime));
		} else if (providers.length === 1 && providers[0] === "*") {
			if (!anchorMessage) {
				this.runtime.logger.warn(
					{
						src: "prompt-batcher",
						agentId: this.runtime.agentId,
						sectionId: section.id,
					},
					"Prompt batcher section requires providers but no anchor message exists",
				);
				return null;
			}

			const state = await this.runtime.composeState(anchorMessage);
			pieces.push(state.text ?? "");
		} else if (providers.length > 0) {
			if (!anchorMessage) {
				this.runtime.logger.warn(
					{
						src: "prompt-batcher",
						agentId: this.runtime.agentId,
						sectionId: section.id,
					},
					"Prompt batcher section requires selective providers but no anchor message exists",
				);
				return null;
			}

			const state = await this.runtime.composeState(
				anchorMessage,
				providers,
				true,
			);
			pieces.push(state.text ?? "");
		}

		if (section.contextBuilder) {
			try {
				const built = await section.contextBuilder(this.runtime, messages);
				if (built) {
					pieces.push(String(built));
				}
			} catch (error) {
				this.runtime.logger.warn(
					{
						src: "prompt-batcher",
						agentId: this.runtime.agentId,
						sectionId: section.id,
						error,
					},
					"Prompt batcher contextBuilder failed; using placeholder context",
				);
				pieces.push("[context unavailable]");
			}
		}

		for (const slug of section.contextResolvers ?? []) {
			let resolvedText = resolverCache.get(slug);
			if (!resolvedText) {
				const resolver = this.contextResolvers.get(slug);
				if (!resolver) {
					this.runtime.logger.warn(
						{
							src: "prompt-batcher",
							agentId: this.runtime.agentId,
							sectionId: section.id,
							slug,
						},
						"Prompt batcher context resolver not found",
					);
					continue;
				}

				try {
					resolvedText = String(await resolver(this.runtime, messages));
				} catch (error) {
					this.runtime.logger.warn(
						{
							src: "prompt-batcher",
							agentId: this.runtime.agentId,
							sectionId: section.id,
							slug,
							error,
						},
						"Prompt batcher context resolver failed; using placeholder context",
					);
					resolvedText = "[context unavailable]";
				}
				resolverCache.set(slug, resolvedText);
			}
			if (resolvedText) {
				pieces.push(resolvedText);
			}
		}

		if (
			(section.providers == null || section.providers.length === 0) &&
			Array.from(this.sections.values()).some(
				(other) =>
					other.id !== section.id &&
					(other.affinityKey ?? "default") ===
						(section.affinityKey ?? "default") &&
					other.providers?.includes("*"),
			)
		) {
			this.runtime.logger.warn(
				{
					src: "prompt-batcher",
					agentId: this.runtime.agentId,
					sectionId: section.id,
					affinityKey: section.affinityKey ?? "default",
				},
				"Prompt batcher affinity group mixes cheap and full-provider sections; consider separate affinity keys",
			);
		}

		const resolvedContext = pieces.filter(Boolean).join("\n\n");
		const schemaFieldCount = section.schema.length;
		const estimatedTokens = Math.ceil(
			(resolvedContext.length + JSON.stringify(section.schema).length) / 4,
		);

		return {
			section,
			resolvedContext,
			contextCharCount: resolvedContext.length,
			schemaFieldCount,
			estimatedTokens,
			priority: section.priority ?? "normal",
			preferredModel: section.model ?? "small",
			isolated: section.isolated ?? false,
			affinityKey: section.affinityKey ?? "default",
			execOptions: section.execOptions,
		};
	}

	private _getMessagesForAffinity(affinityKey: string): Memory[] {
		return [...(this.messageBuffers.get(affinityKey) ?? [])];
	}

	/**
	 * Deliver a section result: optionally run onResult, then resolve or reject the
	 * section's promise. Resolve with { fields, meta } so the thenable API gets a
	 * single object. WHY: Consistent result shape; callers can .catch() when we reject.
	 * Guard pending.resolved so we never resolve and reject the same promise (e.g. if
	 * onResult throws we reject and return; if we later delivered again we would skip resolve).
	 */
	private async _deliverSectionResult(args: {
		section: PromptSection;
		fields: Record<string, unknown>;
		meta: DrainMeta;
		removeOnceSection: boolean;
	}): Promise<void> {
		if (args.meta.fallbackUsed) {
			this.stats.totalFallbacks += 1;
		}

		const pending = this.pendingResults.get(args.section.id);

		if (!this.disposed && args.section.onResult) {
			try {
				await args.section.onResult(args.fields, args.meta);
			} catch (error) {
				this.runtime.logger.warn(
					{
						src: "prompt-batcher",
						agentId: this.runtime.agentId,
						sectionId: args.section.id,
						error,
					},
					"Prompt batcher onResult failed",
				);
				if (pending && !pending.resolved) {
					pending.resolved = true;
					pending.deferred.reject(error); // WHY: Caller can .catch() for real failures.
				}
				if (args.removeOnceSection && args.section.frequency === "once") {
					this.sections.delete(args.section.id);
					this.pendingResults.delete(args.section.id);
				}
				return;
			}
		}

		if (pending && !pending.resolved) {
			pending.resolved = true;
			pending.deferred.resolve({ fields: args.fields, meta: args.meta });
		}

		if (args.removeOnceSection && args.section.frequency === "once") {
			this.sections.delete(args.section.id);
			this.pendingResults.delete(args.section.id);
		}
	}

	private _fallbackForSection(section: PromptSection): Record<string, unknown> {
		return section.fallback?.() ?? {};
	}

	private _normalizeFallback(
		fallback?: Record<string, unknown>,
	): (() => Record<string, unknown>) | undefined {
		if (!fallback) {
			return undefined;
		}
		return () => ({ ...fallback });
	}

	private async _checkCache(section: PromptSection): Promise<{
		hit: boolean;
		stale: boolean;
		fields?: Record<string, unknown>;
	}> {
		if (!section.cacheTtlMs || section.forceRegenerate) {
			return { hit: false, stale: false };
		}

		const key = this._cacheKey(section.id);
		let entry = this.inMemoryCache.get(key);
		if (!entry) {
			const persisted = await this.runtime.getCache<CacheEntry>(key);
			if (persisted?.fields && typeof persisted.expiresAt === "number") {
				entry = persisted;
				this.inMemoryCache.set(key, persisted);
			}
		}

		if (!entry) {
			return { hit: false, stale: false };
		}

		if (entry.expiresAt > Date.now()) {
			return { hit: true, stale: false, fields: entry.fields };
		}

		if (section.staleWhileRevalidate) {
			return { hit: true, stale: true, fields: entry.fields };
		}

		return { hit: false, stale: false };
	}

	private async _writeCache(
		section: PromptSection,
		fields: Record<string, unknown>,
	): Promise<void> {
		if (!section.cacheTtlMs) {
			return;
		}

		const entry: CacheEntry = {
			fields,
			expiresAt: Date.now() + section.cacheTtlMs,
		};
		const key = this._cacheKey(section.id);
		this.inMemoryCache.set(key, entry);
		await this.runtime.setCache(key, entry);
	}

	private _runValidate(
		section: PromptSection,
		fields: Record<string, unknown>,
	): Record<string, unknown> | null {
		if (!section.validate) {
			return fields;
		}

		try {
			return section.validate(fields);
		} catch (error) {
			this.runtime.logger.warn(
				{
					src: "prompt-batcher",
					agentId: this.runtime.agentId,
					sectionId: section.id,
					error,
				},
				"Prompt batcher validate threw",
			);
			return null;
		}
	}

	private async _retrySection(
		resolvedSection: ResolvedSection,
		messages: Memory[],
		attempt: number,
		retriedCallIds: Set<string>,
	): Promise<Record<string, unknown> | null> {
		const maxRetries = clampRetryCount(resolvedSection.section.maxRetries);
		if (attempt > maxRetries) {
			return null;
		}

		retriedCallIds.add(resolvedSection.section.id);
			const prompt = [
				"Previous attempt was invalid. Try again.",
				resolvedSection.section.preamble ?? "",
				`Context:\n${resolvedSection.resolvedContext || "[context unavailable]"}`,
			"Return only the requested structured fields.",
		]
				.filter(Boolean)
				.join("\n\n");
			const params = {
				prompt,
				...(resolvedSection.execOptions ?? {}),
			} satisfies Omit<GenerateTextParams, "prompt"> & { prompt: string };

			const response = await this.runtime.dynamicPromptExecFromState({
				state: createMinimalState(resolvedSection.resolvedContext),
				params,
				schema: resolvedSection.section.schema,
			options: {
				modelSize: resolvedSection.preferredModel,
			},
		});

		if (!response) {
			return null;
		}

		const validated = this._runValidate(resolvedSection.section, response);
		if (validated) {
			return validated;
		}

		return this._retrySection(
			resolvedSection,
			messages,
			attempt + 1,
			retriedCallIds,
		);
	}

	private _emitDrainLog(log: DrainLog): void {
		this.runtime.logger.debug(
			{
				src: "prompt-batcher",
				agentId: this.runtime.agentId,
				drain: log,
			},
			"Prompt batcher drain completed",
		);
	}

	private _cacheKey(sectionId: string): string {
		return `prompt-batcher:${String(this.runtime.agentId)}:${sectionId}`;
	}

	private _validateProviders(providers?: string[]): void {
		if (
			!providers ||
			providers.length === 0 ||
			(providers.length === 1 && providers[0] === "*")
		) {
			return;
		}

		const knownProviders = new Set(
			this.runtime.providers.map((provider) => provider.name),
		);
		for (const provider of providers) {
			if (!knownProviders.has(provider)) {
				this.runtime.logger.warn(
					{
						src: "prompt-batcher",
						agentId: this.runtime.agentId,
						provider,
					},
					"Prompt batcher section references unknown provider",
				);
			}
		}
	}
}
