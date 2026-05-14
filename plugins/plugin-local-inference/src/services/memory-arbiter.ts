/**
 * Memory Arbiter — single in-process owner of every model handle (text,
 * embedding, vision-language, ASR, TTS, image generation) for the local
 * inference stack. WS1 deliverable.
 *
 * Why this exists
 * ---------------
 * The current code has every plugin loading independently:
 *
 *   - `plugin-local-inference` owns the text + voice GGUFs through
 *     `LocalInferenceEngine` + `SharedResourceRegistry`.
 *   - `plugin-vision` loads its own TF.js / face-api models with no
 *     shared budget.
 *   - `plugin-aosp-local-inference` runs the bun:ffi llama.cpp binding
 *     in its own world, also with no shared budget.
 *
 * On a 6 GB iPhone or an 8 GB low-tier Android, that means loading a
 * vision model on top of a text model gets the app jetsam'd / lmkd-killed
 * before the planner even runs.
 *
 * The arbiter is the single seam every consumer goes through to acquire
 * a model. It owns the eviction policy across modalities (the existing
 * `ResidentModelRole` priority table + memory-pressure signals from the
 * platform), it owns the queue for capability swaps (a vision-describe
 * arriving while the text model is generating waits its turn rather than
 * triggering a parallel load that OOMs), and it owns the
 * `vision-embedding-cache` so repeat frames don't re-pay the projector.
 *
 * What this module does NOT do
 * ----------------------------
 *   - It does not implement any model loader. Loaders are passed in via
 *     `registerCapability(...)` by the plugins that own the binding
 *     (plugin-local-inference for text/embedding, plugin-vision for
 *     vision-describe, plugin-image-gen for diffusion, etc.).
 *   - It does not download models, probe hardware, or render UI. Those
 *     are the existing `Downloader`, `probeHardware`, and Settings UI
 *     concerns.
 *   - It does not run on a worker thread. One process, one event loop —
 *     the arbiter coordinates async work via promises only.
 *
 * Consumer contract
 * -----------------
 * Capability handlers register themselves at boot:
 *
 *   ```ts
 *   arbiter.registerCapability({
 *     capability: "vision-describe",
 *     residentRole: "vision",
 *     load: async (modelKey) => loadQwen3VL(modelKey),
 *     unload: async (handle) => handle.dispose(),
 *     run: async (handle, req) => handle.describe(req.imageBytes),
 *   });
 *   ```
 *
 * Then anyone can call:
 *
 *   ```ts
 *   const result = await arbiter.requestVisionDescribe({
 *     modelKey: "qwen3-vl-4b",
 *     imageBytes: pixels,
 *   });
 *   ```
 *
 * The arbiter handles:
 *   1. Acquiring (or reusing) the handle for `qwen3-vl-4b`.
 *   2. If a different capability holds the active model and we need to
 *      swap, evicting it first.
 *   3. Running the request.
 *   4. Releasing the handle (refcounted; the handle stays loaded until
 *      pressure or idle eviction reclaims it).
 *
 * Telemetry
 * ---------
 * The arbiter emits typed events:
 *   - `model_load`     — a handle came online (capability, modelKey, ms)
 *   - `model_unload`   — a handle went offline (capability, modelKey, reason)
 *   - `memory_pressure` — pressure level changed (level, source, freeMb?)
 *   - `eviction`       — a role was evicted (capability, modelKey, reason)
 *   - `capability_run` — a request completed (capability, modelKey, ms)
 *
 * The runtime observability layer subscribes via `onEvent(...)`.
 */

import type {
	MemoryPressureEvent,
	MemoryPressureLevel,
	MemoryPressureSource,
} from "./memory-pressure";
import {
	VisionEmbeddingCache,
	type VisionEmbeddingEntry,
} from "./vision-embedding-cache";
import {
	createEvictableModelRole,
	type EvictableModelRole,
	RESIDENT_ROLE_PRIORITY,
	type ResidentModelRole,
	type SharedResourceRegistry,
} from "./voice/shared-resources";

/**
 * Capability identifiers the arbiter routes between. One per consumer
 * surface — keep this list short; new capabilities should be added
 * deliberately, not on a whim.
 */
export type ArbiterCapability =
	| "text"
	| "embedding"
	| "vision-describe"
	| "image-gen"
	| "transcribe"
	| "speak";

/**
 * Map a capability to the resident-role bucket the existing
 * `SharedResourceRegistry` already tracks. Adding a new capability MUST
 * extend this map so the eviction priority is well-defined.
 */
const CAPABILITY_ROLE: Readonly<Record<ArbiterCapability, ResidentModelRole>> =
	{
		text: "text-target",
		embedding: "embedding",
		"vision-describe": "vision",
		// Image-gen has no slot in `ResidentModelRole` today (it's a future
		// modality). We park it on `vision` priority so it co-evicts with the
		// VL model — both are GPU-heavy weights with similar lifecycles.
		"image-gen": "vision",
		transcribe: "asr",
		speak: "tts",
	};

/** The opaque handle returned by `acquire`. Callers MUST `release` it. */
export interface ArbiterHandle<TBackend = unknown> {
	readonly capability: ArbiterCapability;
	readonly modelKey: string;
	readonly backend: TBackend;
	/**
	 * Increment the refcount so the handle is shared. Returns the same
	 * underlying handle. Useful when one consumer hands the handle to
	 * another mid-flight.
	 */
	retain(): void;
	/** Decrement the refcount. When it hits zero the role becomes evictable. */
	release(): Promise<void>;
}

/**
 * What a capability handler tells the arbiter about itself. The arbiter
 * uses these to load on demand, run requests, and unload under pressure.
 */
export interface CapabilityRegistration<TBackend, TRequest, TResult> {
	capability: ArbiterCapability;
	/**
	 * Optional override for the resident-role priority. Defaults to the
	 * `CAPABILITY_ROLE` map; pass when a specific binding has different
	 * eviction semantics than the default for its capability.
	 */
	residentRole?: ResidentModelRole;
	/**
	 * Best-effort estimate of bytes the model occupies in RAM/VRAM once
	 * loaded. Used by telemetry only — eviction picks by *priority*, not by
	 * size, so a wrong estimate doesn't change behaviour. 0 when unknown.
	 */
	estimatedMb?: number;
	/** Load the backend for a given model key. Called at most once per (capability, modelKey). */
	load: (modelKey: string) => Promise<TBackend>;
	/** Tear the backend down. The arbiter stops referencing it after this resolves. */
	unload: (backend: TBackend) => Promise<void>;
	/** Run one request through the backend. */
	run: (backend: TBackend, request: TRequest) => Promise<TResult>;
}

interface ResidentEntry {
	capability: ArbiterCapability;
	modelKey: string;
	backend: unknown;
	residentRole: ResidentModelRole;
	estimatedMb: number;
	refCount: number;
	loadedAtMs: number;
	roleId: string;
}

/** Telemetry event the runtime observability layer can subscribe to. */
export type ArbiterEvent =
	| {
			type: "model_load";
			capability: ArbiterCapability;
			modelKey: string;
			loadMs: number;
			atMs: number;
	  }
	| {
			type: "model_unload";
			capability: ArbiterCapability;
			modelKey: string;
			reason: "release" | "swap" | "pressure" | "shutdown";
			atMs: number;
	  }
	| {
			type: "memory_pressure";
			level: MemoryPressureLevel;
			source: string;
			freeMb?: number;
			atMs: number;
	  }
	| {
			type: "eviction";
			capability: ArbiterCapability;
			modelKey: string;
			reason: "pressure" | "swap";
			estimatedMb: number;
			atMs: number;
	  }
	| {
			type: "capability_run";
			capability: ArbiterCapability;
			modelKey: string;
			runMs: number;
			atMs: number;
	  };

export type ArbiterEventListener = (event: ArbiterEvent) => void;

interface QueueEntry<TRequest, TResult> {
	capability: ArbiterCapability;
	modelKey: string;
	request: TRequest;
	resolve: (value: TResult) => void;
	reject: (err: unknown) => void;
}

export interface MemoryArbiterOptions {
	registry: SharedResourceRegistry;
	pressureSource?: MemoryPressureSource;
	visionCache?: VisionEmbeddingCache;
	logger?: {
		info?: (m: string) => void;
		warn?: (m: string) => void;
		debug?: (m: string) => void;
	};
	now?: () => number;
}

/**
 * The arbiter. One instance per process; the plugin owns the singleton
 * (see `index.ts`), and any consumer calls `getMemoryArbiter()` rather
 * than newing one up.
 */
export class MemoryArbiter {
	private readonly registry: SharedResourceRegistry;
	private readonly pressureSource: MemoryPressureSource | null;
	private readonly visionCache: VisionEmbeddingCache;
	private readonly log?: MemoryArbiterOptions["logger"];
	private readonly now: () => number;

	private readonly capabilities = new Map<
		ArbiterCapability,
		CapabilityRegistration<unknown, unknown, unknown>
	>();
	private readonly resident = new Map<string, ResidentEntry>();

	private readonly listeners = new Set<ArbiterEventListener>();
	private pressureUnsubscribe: (() => void) | null = null;
	private currentPressure: MemoryPressureLevel = "nominal";

	/**
	 * One serialized in-flight load per (capability, modelKey) so concurrent
	 * `requestX` calls share a single load promise instead of triggering
	 * duplicate weights into RAM.
	 */
	private readonly inFlightLoads = new Map<string, Promise<ResidentEntry>>();

	/**
	 * Per-capability run queue. The arbiter does NOT serialize across
	 * capabilities; what it serializes is the *swap*: when a request needs
	 * to evict another resident role first, the ongoing run on that role is
	 * allowed to finish, then the swap proceeds. Concurrent runs against the
	 * same loaded handle pass through directly.
	 */
	private readonly queues = new Map<
		ArbiterCapability,
		QueueEntry<unknown, unknown>[]
	>();
	private readonly running = new Map<ArbiterCapability, boolean>();

	private shuttingDown = false;

	constructor(opts: MemoryArbiterOptions) {
		this.registry = opts.registry;
		this.pressureSource = opts.pressureSource ?? null;
		this.visionCache = opts.visionCache ?? new VisionEmbeddingCache();
		this.log = opts.logger;
		this.now = opts.now ?? (() => Date.now());
	}

	/** Begin observing memory pressure. Idempotent. */
	start(): void {
		if (this.shuttingDown) {
			throw new Error("[memory-arbiter] cannot start after shutdown");
		}
		if (this.pressureUnsubscribe) return;
		const source = this.pressureSource;
		if (!source) return;
		source.start();
		this.pressureUnsubscribe = source.subscribe((event) => {
			void this.handlePressure(event).catch((err) => {
				this.log?.warn?.(
					`[memory-arbiter] pressure handler failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		});
	}

	/** Stop observing pressure. Does NOT evict resident handles. */
	stop(): void {
		if (this.pressureUnsubscribe) {
			this.pressureUnsubscribe();
			this.pressureUnsubscribe = null;
		}
		this.pressureSource?.stop();
	}

	/** Tear down: stop pressure observation and unload every resident handle. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.stop();
		const keys = Array.from(this.resident.keys());
		for (const key of keys) {
			const entry = this.resident.get(key);
			if (!entry) continue;
			await this.evictEntry(entry, "shutdown").catch((err) => {
				this.log?.warn?.(
					`[memory-arbiter] shutdown evict ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
		this.resident.clear();
		this.inFlightLoads.clear();
	}

	/** Subscribe to telemetry events. Returns the unsubscribe fn. */
	onEvent(listener: ArbiterEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(event: ArbiterEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				this.listeners.delete(listener);
			}
		}
	}

	/** Register a capability handler. Throws on duplicate registration. */
	registerCapability<TBackend, TRequest, TResult>(
		registration: CapabilityRegistration<TBackend, TRequest, TResult>,
	): void {
		if (this.capabilities.has(registration.capability)) {
			throw new Error(
				`[memory-arbiter] capability "${registration.capability}" is already registered`,
			);
		}
		this.capabilities.set(
			registration.capability,
			registration as unknown as CapabilityRegistration<
				unknown,
				unknown,
				unknown
			>,
		);
	}

	/** Whether a capability has been registered. */
	hasCapability(capability: ArbiterCapability): boolean {
		return this.capabilities.has(capability);
	}

	/** Diagnostic snapshot of all resident handles. */
	residentSnapshot(): ReadonlyArray<{
		capability: ArbiterCapability;
		modelKey: string;
		residentRole: ResidentModelRole;
		estimatedMb: number;
		refCount: number;
		loadedAtMs: number;
	}> {
		return Array.from(this.resident.values()).map((e) => ({
			capability: e.capability,
			modelKey: e.modelKey,
			residentRole: e.residentRole,
			estimatedMb: e.estimatedMb,
			refCount: e.refCount,
			loadedAtMs: e.loadedAtMs,
		}));
	}

	currentPressureLevel(): MemoryPressureLevel {
		return this.currentPressure;
	}

	/**
	 * Acquire a handle for `(capability, modelKey)`. If the model is already
	 * resident the refcount is bumped and we return immediately; otherwise we
	 * load it (sharing the in-flight promise across concurrent acquirers).
	 *
	 * Critical pressure causes acquire to throw for non-text capabilities so
	 * we don't load on top of a system the OS has already flagged as in
	 * trouble. Text always loads — without text the agent is a brick.
	 */
	async acquire<TBackend>(
		capability: ArbiterCapability,
		modelKey: string,
	): Promise<ArbiterHandle<TBackend>> {
		const registration = this.capabilities.get(capability);
		if (!registration) {
			throw new Error(
				`[memory-arbiter] no capability registered for "${capability}"`,
			);
		}
		if (this.shuttingDown) {
			throw new Error(
				`[memory-arbiter] arbiter is shutting down; cannot acquire ${capability}`,
			);
		}
		if (this.currentPressure === "critical" && capability !== "text") {
			throw new Error(
				`[memory-arbiter] memory pressure is critical; refusing to load capability "${capability}". Free RAM and retry.`,
			);
		}
		const entry = await this.loadOrReuse(registration, modelKey);
		entry.refCount++;
		return this.handleFor<TBackend>(entry);
	}

	private handleFor<TBackend>(entry: ResidentEntry): ArbiterHandle<TBackend> {
		const arbiter = this;
		let released = false;
		return {
			capability: entry.capability,
			modelKey: entry.modelKey,
			backend: entry.backend as TBackend,
			retain(): void {
				if (released) {
					throw new Error(
						`[memory-arbiter] cannot retain ${entry.capability}/${entry.modelKey} after release`,
					);
				}
				entry.refCount++;
			},
			async release(): Promise<void> {
				if (released) return;
				released = true;
				entry.refCount = Math.max(0, entry.refCount - 1);
				// We don't unload at refcount=0; the role becomes evictable, and
				// the pressure / idle path is what reclaims it. Keeps warm-paths
				// fast.
				arbiter.log?.debug?.(
					`[memory-arbiter] release ${entry.capability}/${entry.modelKey} refcount=${entry.refCount}`,
				);
			},
		};
	}

	private residentKey(capability: ArbiterCapability, modelKey: string): string {
		return `${capability}::${modelKey}`;
	}

	private async loadOrReuse(
		registration: CapabilityRegistration<unknown, unknown, unknown>,
		modelKey: string,
	): Promise<ResidentEntry> {
		const key = this.residentKey(registration.capability, modelKey);
		const existing = this.resident.get(key);
		if (existing) return existing;
		const inFlight = this.inFlightLoads.get(key);
		if (inFlight) return inFlight;

		// Before loading, decide whether the new role conflicts with what's
		// currently resident. The conservative policy: if the same
		// `residentRole` is held by a different modelKey, we evict the
		// existing one first (one model per role). Different roles can co-
		// exist; the pressure path is what rebalances them.
		const role =
			registration.residentRole ?? CAPABILITY_ROLE[registration.capability];
		const conflicts = this.findConflictingRole(
			role,
			registration.capability,
			modelKey,
		);

		const promise = (async (): Promise<ResidentEntry> => {
			for (const conflict of conflicts) {
				if (conflict.refCount > 0) {
					// A different consumer is actively using the conflicting model.
					// Wait for it to drain rather than yanking the rug out — the
					// arbiter does NOT cancel in-flight work for a swap.
					await this.waitForRefcountZero(conflict);
				}
				await this.evictEntry(conflict, "swap");
			}
			const startMs = this.now();
			const backend = await registration.load(modelKey);
			const loadedAtMs = this.now();
			const entry: ResidentEntry = {
				capability: registration.capability,
				modelKey,
				backend,
				residentRole: role,
				estimatedMb: registration.estimatedMb ?? 0,
				refCount: 0,
				loadedAtMs,
				roleId: `arbiter:${registration.capability}:${modelKey}`,
			};
			const evictable = this.makeEvictable(entry, registration);
			this.registry.acquire(evictable);
			this.resident.set(key, entry);
			this.emit({
				type: "model_load",
				capability: registration.capability,
				modelKey,
				loadMs: loadedAtMs - startMs,
				atMs: loadedAtMs,
			});
			this.log?.info?.(
				`[memory-arbiter] loaded ${registration.capability}/${modelKey} in ${loadedAtMs - startMs}ms`,
			);
			return entry;
		})().finally(() => {
			this.inFlightLoads.delete(key);
		});
		this.inFlightLoads.set(key, promise);
		return promise;
	}

	private findConflictingRole(
		role: ResidentModelRole,
		capability: ArbiterCapability,
		modelKey: string,
	): ResidentEntry[] {
		const out: ResidentEntry[] = [];
		for (const entry of this.resident.values()) {
			if (entry.residentRole !== role) continue;
			if (entry.capability === capability && entry.modelKey === modelKey)
				continue;
			out.push(entry);
		}
		return out;
	}

	private async waitForRefcountZero(entry: ResidentEntry): Promise<void> {
		// Cooperative wait — the arbiter doesn't have a per-entry condvar, so
		// we poll on a microtask cadence. Refcount drops happen synchronously
		// inside `release()`, so this terminates within at most one extra
		// run-to-completion cycle when the holder has already released.
		const start = this.now();
		while (entry.refCount > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (this.now() - start > 10_000) {
				throw new Error(
					`[memory-arbiter] timeout waiting for ${entry.capability}/${entry.modelKey} to drain (refcount=${entry.refCount}); refusing to swap mid-flight`,
				);
			}
		}
	}

	private makeEvictable(
		entry: ResidentEntry,
		registration: CapabilityRegistration<unknown, unknown, unknown>,
	): EvictableModelRole {
		return createEvictableModelRole({
			id: entry.roleId,
			role: entry.residentRole,
			evictionPriority: RESIDENT_ROLE_PRIORITY[entry.residentRole],
			estimatedMb: entry.estimatedMb,
			isResident: () =>
				this.resident.has(this.residentKey(entry.capability, entry.modelKey)),
			evict: async () => {
				// The shared registry's monitor calls this. We must be careful not
				// to evict a handle that's actively in use; refcount > 0 means
				// "someone is holding it" and we leave it alone — the registry
				// will pick the next-priority role.
				if (entry.refCount > 0) return;
				await this.evictEntry(entry, "pressure", registration);
			},
		});
	}

	private async evictEntry(
		entry: ResidentEntry,
		reason: "release" | "swap" | "pressure" | "shutdown",
		registration?: CapabilityRegistration<unknown, unknown, unknown>,
	): Promise<void> {
		const key = this.residentKey(entry.capability, entry.modelKey);
		if (!this.resident.has(key)) return;
		this.resident.delete(key);
		try {
			await this.registry.release(entry.roleId);
		} catch (err) {
			this.log?.warn?.(
				`[memory-arbiter] registry release failed for ${entry.roleId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const reg = registration ?? this.capabilities.get(entry.capability);
		try {
			await reg?.unload(entry.backend);
		} catch (err) {
			this.log?.warn?.(
				`[memory-arbiter] unload failed for ${entry.capability}/${entry.modelKey}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		this.emit({
			type: "model_unload",
			capability: entry.capability,
			modelKey: entry.modelKey,
			reason,
			atMs: this.now(),
		});
		if (reason === "pressure" || reason === "swap") {
			this.emit({
				type: "eviction",
				capability: entry.capability,
				modelKey: entry.modelKey,
				reason,
				estimatedMb: entry.estimatedMb,
				atMs: this.now(),
			});
		}
		this.log?.info?.(
			`[memory-arbiter] evicted ${entry.capability}/${entry.modelKey} reason=${reason}`,
		);
	}

	private async handlePressure(event: MemoryPressureEvent): Promise<void> {
		this.currentPressure = event.level;
		this.emit({
			type: "memory_pressure",
			level: event.level,
			source: event.source,
			...(event.freeMb !== undefined ? { freeMb: event.freeMb } : {}),
			atMs: event.atMs,
		});
		if (event.level === "nominal") {
			return;
		}
		// Cheap reclaim first: drop any expired vision-embedding cache entries.
		const purged = this.visionCache.purgeExpired(this.now());
		if (purged > 0) {
			this.log?.debug?.(
				`[memory-arbiter] purged ${purged} expired vision-embedding entries on pressure`,
			);
		}
		// Then ask the SharedResourceRegistry for the cheapest evictable role.
		// `low`: evict one role per pressure tick (gentle).
		// `critical`: evict every non-text role we own.
		if (event.level === "low") {
			await this.registry.evictLowestPriorityRole();
			return;
		}
		// Critical: walk our resident handles in priority order and evict
		// everything that's not the text-target. We do not evict text — losing
		// it bricks the agent and won't actually rescue an OOM that's already
		// past the critical line.
		const entries = Array.from(this.resident.values())
			.filter((e) => e.residentRole !== "text-target")
			.sort(
				(a, b) =>
					RESIDENT_ROLE_PRIORITY[a.residentRole] -
					RESIDENT_ROLE_PRIORITY[b.residentRole],
			);
		for (const entry of entries) {
			if (entry.refCount > 0) continue;
			await this.evictEntry(entry, "pressure");
		}
	}

	// ---------------------------------------------------------------------
	// Capability-specific request fns. Thin wrappers around the queue —
	// each one calls `enqueueRequest` with its capability tag and the
	// caller's request payload. Plugins call these instead of `acquire`
	// directly when they don't need to keep a long-lived handle.
	// ---------------------------------------------------------------------

	requestText<TRequest, TResult>(req: {
		modelKey: string;
		payload: TRequest;
	}): Promise<TResult> {
		return this.enqueueRequest("text", req.modelKey, req.payload);
	}

	requestEmbedding<TRequest, TResult>(req: {
		modelKey: string;
		payload: TRequest;
	}): Promise<TResult> {
		return this.enqueueRequest("embedding", req.modelKey, req.payload);
	}

	requestVisionDescribe<TRequest, TResult>(req: {
		modelKey: string;
		payload: TRequest;
	}): Promise<TResult> {
		return this.enqueueRequest("vision-describe", req.modelKey, req.payload);
	}

	requestImageGen<TRequest, TResult>(req: {
		modelKey: string;
		payload: TRequest;
	}): Promise<TResult> {
		return this.enqueueRequest("image-gen", req.modelKey, req.payload);
	}

	requestTranscribe<TRequest, TResult>(req: {
		modelKey: string;
		payload: TRequest;
	}): Promise<TResult> {
		return this.enqueueRequest("transcribe", req.modelKey, req.payload);
	}

	requestSpeak<TRequest, TResult>(req: {
		modelKey: string;
		payload: TRequest;
	}): Promise<TResult> {
		return this.enqueueRequest("speak", req.modelKey, req.payload);
	}

	private async enqueueRequest<TRequest, TResult>(
		capability: ArbiterCapability,
		modelKey: string,
		payload: TRequest,
	): Promise<TResult> {
		const reg = this.capabilities.get(capability);
		if (!reg) {
			throw new Error(
				`[memory-arbiter] no capability registered for "${capability}"`,
			);
		}
		return new Promise<TResult>((resolve, reject) => {
			const queue = this.queues.get(capability) ?? [];
			queue.push({
				capability,
				modelKey,
				request: payload,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			this.queues.set(capability, queue);
			void this.drainQueue(capability).catch((err) => {
				this.log?.warn?.(
					`[memory-arbiter] queue drain failed for ${capability}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		});
	}

	private async drainQueue(capability: ArbiterCapability): Promise<void> {
		if (this.running.get(capability)) return;
		this.running.set(capability, true);
		try {
			const queue = this.queues.get(capability);
			while (queue && queue.length > 0) {
				const next = queue.shift();
				if (!next) break;
				const reg = this.capabilities.get(capability);
				if (!reg) {
					next.reject(
						new Error(
							`[memory-arbiter] capability "${capability}" was deregistered mid-queue`,
						),
					);
					continue;
				}
				try {
					const handle = await this.acquire(capability, next.modelKey);
					const startMs = this.now();
					try {
						const result = await reg.run(handle.backend, next.request);
						const runMs = this.now() - startMs;
						this.emit({
							type: "capability_run",
							capability,
							modelKey: next.modelKey,
							runMs,
							atMs: this.now(),
						});
						next.resolve(result);
					} finally {
						await handle.release();
					}
				} catch (err) {
					next.reject(err);
				}
			}
		} finally {
			this.running.set(capability, false);
		}
	}

	// ---------------------------------------------------------------------
	// Vision-embedding cache passthroughs.
	// ---------------------------------------------------------------------

	getCachedVisionEmbedding(hash: string): VisionEmbeddingEntry | null {
		return this.visionCache.get(hash);
	}

	setCachedVisionEmbedding(
		hash: string,
		entry: { tokens: Float32Array; tokenCount: number; hiddenSize: number },
		ttlMs?: number,
	): void {
		this.visionCache.set(hash, entry, ttlMs);
	}
}

/**
 * Process-wide singleton accessor. The plugin's `index.ts` calls
 * `setMemoryArbiter` once at boot; consumers call `getMemoryArbiter`.
 * Throws when no arbiter has been configured — the runtime is expected
 * to set one before any consumer touches it.
 */
let globalArbiter: MemoryArbiter | null = null;

export function setMemoryArbiter(arbiter: MemoryArbiter | null): void {
	globalArbiter = arbiter;
}

export function getMemoryArbiter(): MemoryArbiter {
	if (!globalArbiter) {
		throw new Error(
			"[memory-arbiter] no arbiter configured; call setMemoryArbiter() at plugin init",
		);
	}
	return globalArbiter;
}

/** Test/diagnostic — returns the singleton without throwing. */
export function tryGetMemoryArbiter(): MemoryArbiter | null {
	return globalArbiter;
}
