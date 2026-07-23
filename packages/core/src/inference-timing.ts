/**
 * Per-turn inference latency tracing.
 *
 * A turn-scoped span/mark recorder that answers one question: "where did the
 * wall-clock time of this response go?" It is the text/cloud sibling of the
 * voice loop's `EndToEndLatencyTracer` (plugin-local-inference) — same intent,
 * different shape: voice has a fixed ordered checkpoint set; a text turn has an
 * open-ended set of named spans (composeState, the model round-trip, the HTTP
 * fetch, the concurrency-limiter wait, evaluators) that every layer of the
 * stack contributes to without threading a recorder reference.
 *
 * Threading model (mirrors `streaming-context.ts`): the message handler opens a
 * timer with {@link runWithInferenceTiming} for the turn; any code running
 * inside that async scope — `AgentRuntime.useModel`, `composeState`, the
 * elizaOS Cloud HTTP handler, the evaluator service — calls the context-free
 * helpers ({@link timeInferenceSpan}, {@link recordInferenceSpan},
 * {@link markInference}). When no timer is active the helpers are zero-cost
 * no-ops, so instrumentation is safe to leave on every code path.
 *
 * A missing measurement is recorded as missing, never synthesized (AGENTS.md
 * §3 / §8): derived metrics whose endpoint mark was never recorded stay `null`.
 *
 * Logger only, `[InferenceTiming]` prefix (AGENTS.md §9).
 */

import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Span / mark shapes
// ---------------------------------------------------------------------------

export type InferenceTimingMeta = Record<string, string | number | boolean>;

export interface InferenceSpan {
	/** Stage name, e.g. `composeState`, `model:RESPONSE_HANDLER`,
	 *  `cloud.http:/chat/completions`, `cloud.semaphore-wait`, `evaluators`. */
	name: string;
	/** Wall-clock ms since the turn's `t0` when the span opened. */
	startMs: number;
	/** Wall-clock ms since `t0` when the span closed. */
	endMs: number;
	/** `endMs - startMs`. */
	durationMs: number;
	meta?: InferenceTimingMeta;
}

export interface InferenceMark {
	name: string;
	/** Wall-clock ms since the turn's `t0`. */
	tMs: number;
}

/** Canonical point-in-time marks the summary derives headline metrics from. */
export const INFERENCE_MARKS = {
	/** First streamed token/char delivered to the caller (streaming only). */
	firstToken: "first-token",
	/** The user-visible reply was handed to the delivery callback. */
	replyDelivered: "reply-delivered",
} as const;

export interface InferenceTurnSummary {
	turnId: string;
	label: string;
	roomId: string | null;
	modelProvider: string | null;
	t0EpochMs: number;
	closedAtEpochMs: number | null;
	/** `t0` → turn close. Null while the turn is still open. */
	totalMs: number | null;
	/** `t0` → `first-token` mark; null when nothing streamed. */
	timeToFirstTokenMs: number | null;
	/** `t0` → `reply-delivered` mark; null when no reply was delivered. */
	timeToReplyMs: number | null;
	spans: InferenceSpan[];
	marks: InferenceMark[];
	/**
	 * Per-span-name roll-up: total ms and count within this turn. Durations can
	 * sum past wall-clock time because sibling spans (e.g. parallel providers)
	 * overlap — this is a contribution view, not a timeline partition.
	 */
	byName: Record<string, { totalMs: number; count: number }>;
	anomalies: string[];
}

// ---------------------------------------------------------------------------
// Turn timer
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SPANS = 512;

export class InferenceTurnTimer {
	readonly turnId: string;
	readonly label: string;
	readonly roomId: string | null;
	readonly t0EpochMs: number;
	modelProvider: string | null = null;

	private readonly spans: InferenceSpan[] = [];
	private readonly marks = new Map<string, number>();
	private readonly anomalies: string[] = [];
	private readonly maxSpans: number;
	private closedAtEpochMs: number | null = null;

	constructor(args: {
		turnId: string;
		label: string;
		roomId?: string | null;
		t0EpochMs?: number;
		maxSpans?: number;
	}) {
		this.turnId = args.turnId;
		this.label = args.label;
		this.roomId = args.roomId ?? null;
		this.t0EpochMs = args.t0EpochMs ?? Date.now();
		this.maxSpans = Math.max(1, args.maxSpans ?? DEFAULT_MAX_SPANS);
	}

	private rel(epochMs: number): number {
		return epochMs - this.t0EpochMs;
	}

	/** Open a span; returns a function that closes it. Safe to call the closer
	 *  more than once (subsequent calls are ignored). */
	openSpan(name: string, meta?: InferenceTimingMeta): () => void {
		const startEpoch = Date.now();
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			this.recordSpanAbsolute(name, startEpoch, Date.now(), meta);
		};
	}

	/** Record a span whose duration was already measured by the caller. */
	recordSpan(
		name: string,
		durationMs: number,
		meta?: InferenceTimingMeta,
	): void {
		if (!Number.isFinite(durationMs) || durationMs < 0) return;
		const endEpoch = Date.now();
		this.recordSpanAbsolute(name, endEpoch - durationMs, endEpoch, meta);
	}

	private recordSpanAbsolute(
		name: string,
		startEpoch: number,
		endEpoch: number,
		meta?: InferenceTimingMeta,
	): void {
		if (this.spans.length >= this.maxSpans) {
			if (this.anomalies.length === 0 || !this.anomalies.includes("span-cap")) {
				this.anomalies.push("span-cap");
			}
			return;
		}
		this.spans.push({
			name,
			startMs: this.rel(startEpoch),
			endMs: this.rel(endEpoch),
			durationMs: Math.max(0, endEpoch - startEpoch),
			...(meta ? { meta } : {}),
		});
	}

	/** Record a once-per-turn point mark. A duplicate keeps the first. */
	mark(name: string, atEpochMs?: number): void {
		if (this.marks.has(name)) {
			this.anomalies.push(`duplicate mark "${name}"`);
			return;
		}
		this.marks.set(name, atEpochMs ?? Date.now());
	}

	/** Attribute the turn to a model provider (first writer wins). */
	setModelProvider(provider: string | null | undefined): void {
		if (provider && !this.modelProvider) this.modelProvider = provider;
	}

	close(): InferenceTurnSummary {
		if (this.closedAtEpochMs === null) this.closedAtEpochMs = Date.now();
		return this.summary();
	}

	summary(): InferenceTurnSummary {
		const marks: InferenceMark[] = [];
		for (const [name, at] of this.marks) {
			marks.push({ name, tMs: this.rel(at) });
		}
		marks.sort((a, b) => a.tMs - b.tMs);

		const byName: Record<string, { totalMs: number; count: number }> = {};
		for (const s of this.spans) {
			const entry = byName[s.name] ?? { totalMs: 0, count: 0 };
			entry.totalMs += s.durationMs;
			entry.count += 1;
			byName[s.name] = entry;
		}

		const markRel = (name: string): number | null => {
			const at = this.marks.get(name);
			return at === undefined ? null : this.rel(at);
		};

		return {
			turnId: this.turnId,
			label: this.label,
			roomId: this.roomId,
			modelProvider: this.modelProvider,
			t0EpochMs: this.t0EpochMs,
			closedAtEpochMs: this.closedAtEpochMs,
			totalMs:
				this.closedAtEpochMs === null ? null : this.rel(this.closedAtEpochMs),
			timeToFirstTokenMs: markRel(INFERENCE_MARKS.firstToken),
			timeToReplyMs: markRel(INFERENCE_MARKS.replyDelivered),
			spans: [...this.spans].sort((a, b) => a.startMs - b.startMs),
			marks,
			byName,
			anomalies: [...this.anomalies],
		};
	}
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage context (mirrors streaming-context.ts)
// ---------------------------------------------------------------------------

interface IInferenceTimingContextManager {
	run<T>(timer: InferenceTurnTimer | undefined, fn: () => T): T;
	active(): InferenceTurnTimer | undefined;
}

function isNodeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

function initContextManager(): IInferenceTimingContextManager {
	if (isNodeEnvironment()) {
		try {
			const { AsyncLocalStorage } =
				require("node:async_hooks") as typeof import("node:async_hooks");
			const storage = new AsyncLocalStorage<InferenceTurnTimer | undefined>();
			return {
				run<T>(timer: InferenceTurnTimer | undefined, fn: () => T): T {
					return storage.run(timer, fn);
				},
				active(): InferenceTurnTimer | undefined {
					return storage.getStore();
				},
			};
		} catch {
			// AsyncLocalStorage unavailable — fall back to a single-slot store.
		}
	}
	// Browser/edge fallback: a single mutable slot. Does not propagate across
	// independent async tasks, but a turn is processed sequentially per request
	// so the active timer is correct for the common case.
	let current: InferenceTurnTimer | undefined;
	return {
		run<T>(timer: InferenceTurnTimer | undefined, fn: () => T): T {
			const prev = current;
			current = timer;
			try {
				return fn();
			} finally {
				current = prev;
			}
		},
		active(): InferenceTurnTimer | undefined {
			return current;
		},
	};
}

let manager: IInferenceTimingContextManager | null = null;
function getManager(): IInferenceTimingContextManager {
	if (!manager) manager = initContextManager();
	return manager;
}

/** Run `fn` with `timer` as the active turn timer for all nested async work. */
export function runWithInferenceTiming<T>(
	timer: InferenceTurnTimer | undefined,
	fn: () => T,
): T {
	return getManager().run(timer, fn);
}

/** The active turn timer, or undefined when no turn is being timed. */
export function getInferenceTimer(): InferenceTurnTimer | undefined {
	return getManager().active();
}

// ---------------------------------------------------------------------------
// Context-free helpers — no-ops when no timer is active
// ---------------------------------------------------------------------------

/** Time `fn` as a span on the active timer (no-op-times when none active). */
export async function timeInferenceSpan<T>(
	name: string,
	fn: () => Promise<T>,
	meta?: InferenceTimingMeta,
): Promise<T> {
	const timer = getInferenceTimer();
	if (!timer) return fn();
	const close = timer.openSpan(name, meta);
	try {
		return await fn();
	} finally {
		close();
	}
}

/** Record a pre-measured span on the active timer (no-op when none active). */
export function recordInferenceSpan(
	name: string,
	durationMs: number,
	meta?: InferenceTimingMeta,
): void {
	getInferenceTimer()?.recordSpan(name, durationMs, meta);
}

/** Record a point mark on the active timer (no-op when none active). */
export function markInference(name: string, atEpochMs?: number): void {
	getInferenceTimer()?.mark(name, atEpochMs);
}

/** Attribute the active turn to a model provider (no-op when none active). */
export function setInferenceModelProvider(
	provider: string | null | undefined,
): void {
	getInferenceTimer()?.setModelProvider(provider);
}

// ---------------------------------------------------------------------------
// Process-wide registry (bounded ring + per-span histograms) for a dev endpoint
// ---------------------------------------------------------------------------

export interface InferenceHistogramSummary {
	count: number;
	p50: number | null;
	p90: number | null;
	p99: number | null;
	min: number | null;
	max: number | null;
	mean: number | null;
}

class BoundedHistogram {
	private readonly samples: number[] = [];
	constructor(private readonly capacity: number) {}
	add(value: number): void {
		if (!Number.isFinite(value)) return;
		this.samples.push(value);
		if (this.samples.length > this.capacity) this.samples.shift();
	}
	summary(): InferenceHistogramSummary {
		const n = this.samples.length;
		if (n === 0) {
			return {
				count: 0,
				p50: null,
				p90: null,
				p99: null,
				min: null,
				max: null,
				mean: null,
			};
		}
		const sorted = [...this.samples].sort((a, b) => a - b);
		const pct = (p: number): number => {
			const rank = Math.ceil((p / 100) * n);
			return sorted[Math.min(n - 1, Math.max(0, rank - 1))] as number;
		};
		const sum = sorted.reduce((acc, v) => acc + v, 0);
		return {
			count: n,
			p50: pct(50),
			p90: pct(90),
			p99: pct(99),
			min: sorted[0] as number,
			max: sorted[n - 1] as number,
			mean: sum / n,
		};
	}
}

const REGISTRY_RING_CAPACITY = 64;
const REGISTRY_HISTOGRAM_CAPACITY = 256;

class InferenceTimingRegistry {
	private readonly ring: InferenceTurnSummary[] = [];
	private readonly spanHistograms = new Map<string, BoundedHistogram>();
	private readonly ttft = new BoundedHistogram(REGISTRY_HISTOGRAM_CAPACITY);
	private readonly ttreply = new BoundedHistogram(REGISTRY_HISTOGRAM_CAPACITY);
	private readonly total = new BoundedHistogram(REGISTRY_HISTOGRAM_CAPACITY);

	record(summary: InferenceTurnSummary): void {
		this.ring.push(summary);
		while (this.ring.length > REGISTRY_RING_CAPACITY) this.ring.shift();
		for (const [name, agg] of Object.entries(summary.byName)) {
			let h = this.spanHistograms.get(name);
			if (!h) {
				h = new BoundedHistogram(REGISTRY_HISTOGRAM_CAPACITY);
				this.spanHistograms.set(name, h);
			}
			h.add(agg.totalMs);
		}
		if (summary.timeToFirstTokenMs !== null)
			this.ttft.add(summary.timeToFirstTokenMs);
		if (summary.timeToReplyMs !== null) this.ttreply.add(summary.timeToReplyMs);
		if (summary.totalMs !== null) this.total.add(summary.totalMs);
	}

	recentTurns(limit: number): InferenceTurnSummary[] {
		if (limit >= this.ring.length) return [...this.ring];
		return this.ring.slice(this.ring.length - limit);
	}

	spanSummaries(): Record<string, InferenceHistogramSummary> {
		const out: Record<string, InferenceHistogramSummary> = {};
		for (const [name, h] of this.spanHistograms) out[name] = h.summary();
		return out;
	}

	derivedSummaries(): Record<string, InferenceHistogramSummary> {
		return {
			timeToFirstTokenMs: this.ttft.summary(),
			timeToReplyMs: this.ttreply.summary(),
			totalMs: this.total.summary(),
		};
	}

	reset(): void {
		this.ring.length = 0;
		this.spanHistograms.clear();
	}
}

export const inferenceTimingRegistry = new InferenceTimingRegistry();

export interface InferenceTimingDevPayload {
	generatedAtEpochMs: number;
	turns: InferenceTurnSummary[];
	spanHistograms: Record<string, InferenceHistogramSummary>;
	derivedHistograms: Record<string, InferenceHistogramSummary>;
}

/** JSON body for a dev endpoint (e.g. `GET /api/dev/inference-timing`). */
export function buildInferenceTimingDevPayload(
	limit = 50,
): InferenceTimingDevPayload {
	return {
		generatedAtEpochMs: Date.now(),
		turns: inferenceTimingRegistry.recentTurns(limit),
		spanHistograms: inferenceTimingRegistry.spanSummaries(),
		derivedHistograms: inferenceTimingRegistry.derivedSummaries(),
	};
}

// ---------------------------------------------------------------------------
// Emission — one structured breakdown per turn
// ---------------------------------------------------------------------------

/**
 * `ELIZA_INFERENCE_TIMING` controls log verbosity:
 *   - unset / "0" / "false": still records into the registry; logs at `debug`.
 *   - truthy: logs the compact breakdown at `info` (the on-by-default debug mode
 *     the operator opts into when chasing latency).
 */
function timingLogEnabled(): boolean {
	const raw =
		typeof process !== "undefined"
			? process.env.ELIZA_INFERENCE_TIMING
			: undefined;
	if (!raw) return false;
	const v = raw.trim().toLowerCase();
	return v !== "" && v !== "0" && v !== "false" && v !== "off";
}

/** A compact `name=ms` breakdown sorted by descending contribution. */
export function formatInferenceTimingSummary(s: InferenceTurnSummary): string {
	const parts: string[] = [];
	if (s.totalMs !== null) parts.push(`total=${s.totalMs}ms`);
	if (s.timeToReplyMs !== null) parts.push(`ttreply=${s.timeToReplyMs}ms`);
	if (s.timeToFirstTokenMs !== null)
		parts.push(`ttft=${s.timeToFirstTokenMs}ms`);
	const ranked = Object.entries(s.byName).sort(
		(a, b) => b[1].totalMs - a[1].totalMs,
	);
	for (const [name, agg] of ranked) {
		parts.push(
			agg.count > 1
				? `${name}=${agg.totalMs}ms(x${agg.count})`
				: `${name}=${agg.totalMs}ms`,
		);
	}
	const head = `[InferenceTiming] ${s.label}`;
	const provider = s.modelProvider ? ` provider=${s.modelProvider}` : "";
	return `${head}${provider} ${parts.join(" ")}`;
}

/**
 * Close the timer, fold it into the process registry, and emit the breakdown.
 * Call once at the end of a turn. No-op-safe for an undefined timer.
 */
export function emitInferenceTiming(
	timer: InferenceTurnTimer | undefined,
): InferenceTurnSummary | null {
	if (!timer) return null;
	try {
		const summary = timer.close();
		inferenceTimingRegistry.record(summary);
		const line = formatInferenceTimingSummary(summary);
		if (timingLogEnabled()) {
			logger.info({ inferenceTiming: summary }, line);
		} else {
			logger.debug({ inferenceTiming: summary }, line);
		}
		return summary;
	} catch (err) {
		logger.warn(
			`[InferenceTiming] emit failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

let TURN_COUNTER = 0;
/** Allocate a process-unique turn id for a new inference timer. */
export function nextInferenceTurnId(): string {
	TURN_COUNTER += 1;
	return `it-${Date.now().toString(36)}-${TURN_COUNTER.toString(36)}`;
}
