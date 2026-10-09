/**
 * Serializes local inference with interactive work ahead of background work and FIFO order
 * within each lane. Background admission has an explicit wait deadline; expiry occurs before
 * native work is enqueued. Active decoding is never preempted, and scheduling budgets never
 * cap model input or output.
 */
import type { LocalInferencePriority } from "../types/model";

/**
 * Device RAM class used by inference admission policy; hosts supply the probe result.
 */
export type InferenceRamClass = "constrained" | "standard";

/**
 * Parses ELIZA_INFERENCE_RAM_CLASS. Unset or invalid values return null so callers can apply
 * their probe or standard policy.
 */
export function inferenceRamClassFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): InferenceRamClass | null {
	const raw = env.ELIZA_INFERENCE_RAM_CLASS?.trim().toLowerCase();
	return raw === "constrained" || raw === "standard" ? raw : null;
}

/**
 * Per-class queue-wait policy for background-priority generation on the single
 * local lane. It prevents stale scheduled work from piling up without changing
 * the generation request once the lane is acquired.
 */
export interface BackgroundInferenceBudget {
	/** Bounded gate wait before the background request fails without running. */
	lockWaitMs: number;
}

const CONSTRAINED_BACKGROUND_BUDGET: BackgroundInferenceBudget = {
	lockWaitMs: 120_000,
};

const STANDARD_BACKGROUND_BUDGET: BackgroundInferenceBudget = {
	lockWaitMs: 300_000,
};

/** Resolve the background generation budget for a device RAM class. */
export function resolveBackgroundInferenceBudget(
	ramClass: InferenceRamClass,
): BackgroundInferenceBudget {
	return ramClass === "constrained"
		? CONSTRAINED_BACKGROUND_BUDGET
		: STANDARD_BACKGROUND_BUDGET;
}

/** Preserves the full background generation request. Device scheduling governs queue admission and never caps model output. */
export function applyBackgroundInferenceBudget(
	args: { prompt: string; maxTokens: number | undefined },
	_budget: BackgroundInferenceBudget,
): { prompt: string; maxTokens: number | undefined; clamped: string[] } {
	return { prompt: args.prompt, maxTokens: args.maxTokens, clamped: [] };
}

/**
 * Thrown when a background acquisition cannot start within its wait budget.
 * The request never reached the native lane; the scheduled-task layer's
 * failure/backoff path handles the re-fire.
 */
export class InferenceBackgroundWaitTimeoutError extends Error {
	readonly code = "INFERENCE_BACKGROUND_WAIT_TIMEOUT";
	constructor(waitedMs: number, holder: string | null) {
		super(
			`[InferencePriorityGate] background inference request timed out after ${waitedMs}ms waiting for the local model lane` +
				(holder ? ` (held by ${holder})` : "") +
				"; the job was not started and will be retried by its scheduler",
		);
		this.name = "InferenceBackgroundWaitTimeoutError";
	}
}

interface GateWaiter {
	priority: LocalInferencePriority;
	label: string;
	enqueuedAtMs: number;
	grant: () => void;
	fail: (err: Error) => void;
	/** Cleanup for the waiter's timeout timer / abort listener. */
	settle: () => void;
}

export interface InferencePriorityGateOptions {
	now?: () => number;
	logger?: {
		info: (msg: string) => void;
		warn: (msg: string) => void;
	};
}

export interface InferencePriorityGateSnapshot {
	held: boolean;
	holderPriority: LocalInferencePriority | null;
	holderLabel: string | null;
	holderHeldMs: number;
	interactiveWaiting: number;
	backgroundWaiting: number;
}

export interface RunExclusiveOptions {
	priority: LocalInferencePriority;
	/**
	 * Bounded wait for background requests, ms. Ignored for interactive
	 * requests (their own transport timeout governs the total).
	 */
	waitMs?: number;
	/** Abort while WAITING dequeues the request; in-flight work is not cancelled here. */
	signal?: AbortSignal;
	/** Short label for lock telemetry (e.g. "TEXT_LARGE", "bionic-generate"). */
	label?: string;
}

/**
 * Two-lane priority lock for the single local inference lane. See module doc.
 */
export class InferencePriorityGate {
	private readonly now: () => number;
	private readonly logger: InferencePriorityGateOptions["logger"];

	private holder: {
		priority: LocalInferencePriority;
		label: string;
		acquiredAtMs: number;
	} | null = null;
	private readonly interactiveQueue: GateWaiter[] = [];
	private readonly backgroundQueue: GateWaiter[] = [];

	constructor(opts: InferencePriorityGateOptions = {}) {
		this.now = opts.now ?? (() => Date.now());
		this.logger = opts.logger;
	}

	snapshot(): InferencePriorityGateSnapshot {
		return {
			held: this.holder !== null,
			holderPriority: this.holder?.priority ?? null,
			holderLabel: this.holder?.label ?? null,
			holderHeldMs: this.holder ? this.now() - this.holder.acquiredAtMs : 0,
			interactiveWaiting: this.interactiveQueue.length,
			backgroundWaiting: this.backgroundQueue.length,
		};
	}

	/**
	 * Run `fn` while holding the lane. Interactive requests wait indefinitely
	 * (FIFO among themselves, always ahead of background); background requests
	 * start only when the lane is idle with no interactive waiter, and fail
	 * with {@link InferenceBackgroundWaitTimeoutError} after `waitMs`.
	 */
	async runExclusive<T>(
		opts: RunExclusiveOptions,
		fn: () => Promise<T>,
	): Promise<T> {
		await this.acquire(opts);
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(opts: RunExclusiveOptions): Promise<void> {
		const label = opts.label ?? "generate";
		const priority = opts.priority;

		if (opts.signal?.aborted) {
			return Promise.reject(
				new Error(
					`[InferencePriorityGate] ${priority} ${label} aborted before acquiring the local model lane`,
				),
			);
		}

		const canStartNow =
			this.holder === null &&
			(priority === "interactive" || this.interactiveQueue.length === 0);
		if (canStartNow) {
			this.holder = { priority, label, acquiredAtMs: this.now() };
			return Promise.resolve();
		}

		if (priority === "interactive" && this.holder?.priority === "background") {
			this.logger?.warn(
				`[InferencePriorityGate] interactive ${label} waiting on a background job (${this.holder.label}) that has held the local model lane for ${this.now() - this.holder.acquiredAtMs}ms; it will run next — ahead of ${this.backgroundQueue.length} queued background job(s)`,
			);
		}

		return new Promise<void>((resolve, reject) => {
			const enqueuedAtMs = this.now();
			let timer: NodeJS.Timeout | null = null;
			let abortListener: (() => void) | null = null;

			const waiter: GateWaiter = {
				priority,
				label,
				enqueuedAtMs,
				grant: () => {
					waiter.settle();
					this.holder = { priority, label, acquiredAtMs: this.now() };
					resolve();
				},
				fail: (err: Error) => {
					waiter.settle();
					this.removeWaiter(waiter);
					reject(err);
				},
				settle: () => {
					if (timer) {
						clearTimeout(timer);
						timer = null;
					}
					if (abortListener && opts.signal) {
						opts.signal.removeEventListener("abort", abortListener);
						abortListener = null;
					}
				},
			};

			if (priority === "background" && opts.waitMs !== undefined) {
				const waitMs = Math.max(0, opts.waitMs);
				timer = setTimeout(() => {
					this.logger?.warn(
						`[InferencePriorityGate] background ${label} gave up after ${this.now() - enqueuedAtMs}ms waiting for the local model lane (holder=${this.holder?.label ?? "none"}, interactiveWaiting=${this.interactiveQueue.length})`,
					);
					waiter.fail(
						new InferenceBackgroundWaitTimeoutError(
							this.now() - enqueuedAtMs,
							this.holder ? this.holder.label : null,
						),
					);
				}, waitMs);
				timer.unref?.();
			}

			if (opts.signal) {
				abortListener = () => {
					waiter.fail(
						new Error(
							`[InferencePriorityGate] ${priority} ${label} aborted while waiting for the local model lane`,
						),
					);
				};
				opts.signal.addEventListener("abort", abortListener, { once: true });
			}

			(priority === "interactive"
				? this.interactiveQueue
				: this.backgroundQueue
			).push(waiter);
		});
	}

	private removeWaiter(waiter: GateWaiter): void {
		const queue =
			waiter.priority === "interactive"
				? this.interactiveQueue
				: this.backgroundQueue;
		const index = queue.indexOf(waiter);
		if (index >= 0) queue.splice(index, 1);
	}

	private release(): void {
		this.holder = null;
		const next = this.interactiveQueue.shift() ?? this.backgroundQueue.shift();
		next?.grant();
	}
}

/**
 * Process-wide singleton: every single-lane local text path in the agent
 * process must share ONE gate, or priority ordering breaks across plugins.
 */
let globalGate: InferencePriorityGate | null = null;

export function getInferencePriorityGate(): InferencePriorityGate {
	if (!globalGate) {
		globalGate = new InferencePriorityGate();
	}
	return globalGate;
}

/** Test hook — replace or clear (null) the process-wide gate. */
export function setInferencePriorityGate(
	gate: InferencePriorityGate | null,
): void {
	globalGate = gate;
}
