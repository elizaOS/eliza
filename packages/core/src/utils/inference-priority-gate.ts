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
 *   - **Interactive FIFO.** Requests acquire the gate before touching the
 *     native lane. Waiting interactive requests dispatch in arrival order.
 *   - **Background never queues.** A background acquisition starts only when
 *     the lane is idle. If another decode owns the lane, it fails immediately
 *     with {@link InferenceLaneBusyError} before native/host work is enqueued.
 *     The scheduled-task layer's existing failure handling (backoff + blocking
 *     re-fire suppression in `TaskService`) coalesces the job instead of
 *     stacking work or waiting for an arbitrary wall-clock deadline.
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
}

const CONSTRAINED_BACKGROUND_BUDGET: BackgroundInferenceBudget = {
	maxTokens: 192,
	maxPromptChars: 4_000,
};

const STANDARD_BACKGROUND_BUDGET: BackgroundInferenceBudget = {
	maxTokens: 1_024,
	maxPromptChars: 24_000,
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
 * Thrown when background inference finds the local lane already owned. The
 * request never queues or reaches the native lane; the scheduled-task layer's
 * failure/backoff path owns any later retry.
 */
export class InferenceLaneBusyError extends Error {
	readonly code = "INFERENCE_LANE_BUSY";
	constructor(holder: string | null) {
		super(
			"[InferencePriorityGate] local model lane is busy; background inference was not queued" +
				(holder ? ` (held by ${holder})` : "") +
				"; the scheduler owns any retry",
		);
		this.name = "InferenceLaneBusyError";
	}
}

interface GateWaiter {
	label: string;
	grant: () => void;
	fail: (err: Error) => void;
	/** Cleanup for the waiter's abort listener. */
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
	/** Abort while WAITING dequeues the request; in-flight work is not cancelled here. */
	signal?: AbortSignal;
	/** Short label for lock telemetry (e.g. "TEXT_LARGE", "bionic-generate"). */
	label?: string;
}

/**
 * Ownership gate for the single local inference lane. See module doc.
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
			// Retained in the snapshot contract for telemetry compatibility.
			// Background work is admission-only and therefore never waits.
			backgroundWaiting: 0,
		};
	}

	/**
	 * Run `fn` while holding the lane. Interactive requests wait FIFO and remain
	 * owner-cancellable. Background requests run only when idle and otherwise
	 * fail immediately with {@link InferenceLaneBusyError}.
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

		if (this.holder === null) {
			this.holder = { priority, label, acquiredAtMs: this.now() };
			return Promise.resolve();
		}

		if (priority === "background") {
			this.logger?.info(
				`[InferencePriorityGate] background ${label} rejected because ${this.holder.label} owns the local model lane`,
			);
			return Promise.reject(new InferenceLaneBusyError(this.holder.label));
		}

		if (this.holder.priority === "background") {
			this.logger?.warn(
				`[InferencePriorityGate] interactive ${label} waiting on a background job (${this.holder.label}) that has held the local model lane for ${this.now() - this.holder.acquiredAtMs}ms; it will run next`,
			);
		}

		return new Promise<void>((resolve, reject) => {
			let abortListener: (() => void) | null = null;

			const waiter: GateWaiter = {
				label,
				grant: () => {
					waiter.settle();
					this.holder = { priority, label, acquiredAtMs: this.now() };
					resolve();
				},
				fail: (err: Error) => {
					waiter.settle();
					const index = this.interactiveQueue.indexOf(waiter);
					if (index >= 0) this.interactiveQueue.splice(index, 1);
					reject(err);
				},
				settle: () => {
					if (abortListener && opts.signal) {
						opts.signal.removeEventListener("abort", abortListener);
						abortListener = null;
					}
				},
			};

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

			this.interactiveQueue.push(waiter);
		});
	}

	private release(): void {
		this.holder = null;
		const next = this.interactiveQueue.shift();
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
