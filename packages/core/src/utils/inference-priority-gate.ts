/**
 * Interactive-over-background scheduling for single-lane local inference
 * (elizaOS/eliza#11914).
 *
 * On-device text generation runs one decode at a time: the Android bionic GPU
 * host serializes every request on its resident-model lock, and the in-process
 * AOSP FFI path shares one fused context. Before this gate, requests reached
 * that lane in arrival order — a long autonomous background job (an ~11k-char
 * prompt at phone prefill speed holds the lock for many minutes) starved
 * interactive chat turns indefinitely, and a background job whose next firing
 * arrived while the previous one still held the lane piled abandoned work onto
 * the host-side queue.
 *
 * The gate is the TS-side owner of that lane:
 *
 *   - **Two lanes, interactive first.** Requests acquire the gate before
 *     touching the native lane. When the lane frees, waiting interactive
 *     requests always dispatch before waiting background requests; within a
 *     lane order is FIFO.
 *   - **Background never queues in front of interactive.** A background
 *     acquisition only starts when the lane is idle AND no interactive request
 *     is waiting.
 *   - **Bounded background wait.** A background acquisition that cannot start
 *     within its wait budget fails with {@link InferenceBackgroundWaitTimeoutError}
 *     BEFORE any native/host work is enqueued. The scheduled-task layer's
 *     existing failure handling (backoff + blocking re-fire suppression in
 *     `TaskService`) then coalesces the job instead of stacking host-side work
 *     — the same structural rule the LifeOps scheduler follows.
 *   - **No preemption.** An in-flight decode is never cancelled; interactive
 *     priority means jumping the queue, not yanking the lock.
 *
 * Consumers: the AOSP fused text handler (`plugin-aosp-local-inference`), the
 * bionic-host loader branch (`plugin-local-inference`), and the mobile
 * device-bridge text handlers (`plugin-capacitor-bridge`). All three run in the
 * same agent process and share the {@link getInferencePriorityGate} singleton.
 *
 * The device-class background budget (#11760 probe seam) lives here too:
 * {@link resolveBackgroundInferenceBudget} caps a background job's `maxTokens`
 * and prompt size by RAM class so a background summarization cannot hold the
 * lane for multi-minute stretches on a constrained phone.
 */

import type { LocalInferencePriority } from "../types/model";

/**
 * Device RAM class for on-device inference policy. Canonical probe
 * (env `ELIZA_INFERENCE_RAM_CLASS` exported by `ElizaAgentService`, with a
 * `/proc/meminfo` fallback) lives in
 * `plugins/plugin-aosp-local-inference/src/inference-memory-policy.ts`
 * (elizaOS/eliza#11760); this type is shared so policy helpers here and the
 * plugin-side probe agree.
 */
export type InferenceRamClass = "constrained" | "standard";

/**
 * Read the #11760 RAM-class env contract (`ELIZA_INFERENCE_RAM_CLASS`,
 * exported into the agent process by `ElizaAgentService` on Android). Returns
 * null when unset/invalid — callers with a richer probe (the AOSP plugin's
 * `classifyInferenceRamClass`, which adds the `/proc/meminfo` fallback) layer
 * it on top; callers without one should treat null as "standard".
 */
export function inferenceRamClassFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): InferenceRamClass | null {
	const raw = env.ELIZA_INFERENCE_RAM_CLASS?.trim().toLowerCase();
	return raw === "constrained" || raw === "standard" ? raw : null;
}

/**
 * Per-class budget for background-priority generation on the single local
 * lane. Sized from the Pixel 6a (`constrained`) measurements in #11734/#11912:
 * marginal prefill ≈ 5.1 tok/s and decode ≤ 7.9 tok/s, so the constrained caps
 * bound a background job's lock hold to a few minutes worst-case instead of
 * the tens of minutes an uncapped 11k-char / 8192-token job costs.
 */
export interface BackgroundInferenceBudget {
	/** Cap on `maxTokens` for a background generation. */
	maxTokens: number;
	/** Cap on prompt length in characters (middle-truncated, ends preserved). */
	maxPromptChars: number;
	/** Bounded gate wait before the background request fails without running. */
	lockWaitMs: number;
}

const CONSTRAINED_BACKGROUND_BUDGET: BackgroundInferenceBudget = {
	maxTokens: 192,
	maxPromptChars: 4_000,
	lockWaitMs: 120_000,
};

const STANDARD_BACKGROUND_BUDGET: BackgroundInferenceBudget = {
	maxTokens: 1_024,
	maxPromptChars: 24_000,
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

const PROMPT_TRUNCATION_MARKER =
	"\n…[middle truncated: on-device background inference budget]…\n";

/**
 * Clamp a background job's prompt to `maxPromptChars` by removing the MIDDLE,
 * preserving the head (system/template opening) and the tail (the most recent
 * context plus the template's generation suffix — e.g. Gemma's
 * `<start_of_turn>model`), so the prompt envelope stays well-formed.
 */
export function clampBackgroundPrompt(
	prompt: string,
	maxPromptChars: number,
): string {
	if (prompt.length <= maxPromptChars) return prompt;
	const usable = maxPromptChars - PROMPT_TRUNCATION_MARKER.length;
	if (usable <= 0) return prompt.slice(-maxPromptChars);
	const headChars = Math.floor(usable * 0.3);
	const tailChars = usable - headChars;
	return (
		prompt.slice(0, headChars) +
		PROMPT_TRUNCATION_MARKER +
		prompt.slice(prompt.length - tailChars)
	);
}

/**
 * Apply the background budget to a generate request. Interactive requests are
 * NEVER clamped — this is for background-priority jobs only. Returns the
 * clamped fields plus a human-readable list of what changed (for the log line
 * at the call site).
 */
export function applyBackgroundInferenceBudget(
	args: { prompt: string; maxTokens: number | undefined },
	budget: BackgroundInferenceBudget,
): { prompt: string; maxTokens: number; clamped: string[] } {
	const clamped: string[] = [];
	let prompt = args.prompt;
	if (prompt.length > budget.maxPromptChars) {
		prompt = clampBackgroundPrompt(prompt, budget.maxPromptChars);
		clamped.push(
			`prompt ${args.prompt.length}→${prompt.length} chars (cap ${budget.maxPromptChars})`,
		);
	}
	let maxTokens = args.maxTokens ?? budget.maxTokens;
	if (maxTokens > budget.maxTokens) {
		clamped.push(`maxTokens ${maxTokens}→${budget.maxTokens}`);
		maxTokens = budget.maxTokens;
	}
	return { prompt, maxTokens, clamped };
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
