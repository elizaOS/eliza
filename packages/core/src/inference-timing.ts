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
 * Each turn also carries a `traceId` — a bounded 32-lowercase-hex id, minted
 * here or adopted from an upstream hop — that outbound callers propagate so a
 * turn's local spans join the records of downstream services (e.g. the elizaOS
 * Cloud gateway) that key their own events to the same id. The format doubles
 * as a W3C `traceparent` trace-id so a hop can forward it without re-minting.
 *
 * A missing measurement is recorded as missing, never synthesized (AGENTS.md
 * §3 / §8): derived metrics whose endpoint mark was never recorded stay `null`.
 * The same rule governs the trace id: a summary rehydrated from a log written
 * before correlation existed reports `traceId: null` rather than a fresh id.
 *
 * Logger only, `[InferenceTiming]` prefix (AGENTS.md §9).
 */

import { ElizaError } from "./errors";
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
	/** First user-visible reply text committed by the host delivery path. */
	firstVisibleReply: "first-visible-reply",
	/** The user-visible reply was handed to the delivery callback. */
	replyDelivered: "reply-delivered",
	/** Host response normalization and all synchronous turn work completed. */
	responseFinalized: "response-finalized",
} as const;

export interface InferenceTurnSummary {
	turnId: string;
	/**
	 * Gateway-compatible correlation id (32 lowercase hex, #16079). Sent as
	 * `X-Eliza-Trace-Id` on elizaOS Cloud calls so one id joins the turn's
	 * local spans with the gateway's structured events and Server-Timing.
	 * Null only for summaries rehydrated from logs persisted before trace
	 * correlation existed — never fabricated for such turns.
	 */
	traceId: string | null;
	label: string;
	roomId: string | null;
	modelProvider: string | null;
	t0EpochMs: number;
	closedAtEpochMs: number | null;
	/** `t0` → turn close. Null while the turn is still open. */
	totalMs: number | null;
	/** `t0` → `first-token` mark; null when nothing streamed. */
	timeToFirstTokenMs: number | null;
	/** `t0` → first host-visible reply text; null when no text was emitted. */
	timeToFirstVisibleMs: number | null;
	/** `t0` → `reply-delivered` mark; null when no reply was delivered. */
	timeToReplyMs: number | null;
	/** `t0` → host response finalization; null outside host-owned chat turns. */
	timeToResponseFinalizedMs: number | null;
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

export const INFERENCE_FLOW_STAGES = [
	"document-augmentation",
	"providers",
	"embedding",
	"model-queue",
	"model-routing",
	"model-preprocess",
	"llm-inference",
	"model-postprocess",
	"actions",
	"evaluators",
	"planner-overhead",
	"response-finalization",
	"message-ingress",
	"message-delivery",
	"message-lifecycle",
	"message-service-overhead",
	"unattributed",
] as const;

export type InferenceFlowStage = (typeof INFERENCE_FLOW_STAGES)[number];

export interface InferenceFlowStageBreakdown {
	stage: InferenceFlowStage;
	/** Exclusive wall time: overlapping child/parent spans are counted once. */
	totalMs: number;
	/** Exclusive wall time before the first visible reply, when available. */
	toFirstVisibleMs: number | null;
	percentOfTotal: number | null;
}

export interface InferenceFlowBreakdown {
	turnId: string;
	totalMs: number | null;
	timeToFirstVisibleMs: number | null;
	stages: InferenceFlowStageBreakdown[];
}

const FLOW_STAGE_PRIORITY: readonly InferenceFlowStage[] = [
	"embedding",
	"model-queue",
	"model-routing",
	"model-preprocess",
	"llm-inference",
	"model-postprocess",
	"actions",
	"evaluators",
	"providers",
	"document-augmentation",
	"response-finalization",
	"message-ingress",
	"message-delivery",
	"message-lifecycle",
	"planner-overhead",
	"message-service-overhead",
];

function classifyInferenceSpan(name: string): InferenceFlowStage | null {
	const normalized = name.toLowerCase();
	if (
		normalized.includes("embedding") ||
		normalized.includes("text_embedding")
	) {
		return "embedding";
	}
	if (
		normalized.includes("semaphore-wait") ||
		normalized.includes("model-queue")
	) {
		return "model-queue";
	}
	if (normalized.startsWith("model-routing:")) return "model-routing";
	if (normalized === "message:stage1:preprocess") return "model-preprocess";
	if (normalized.startsWith("model-preprocess:")) return "model-preprocess";
	if (normalized.startsWith("model-postprocess:")) return "model-postprocess";
	if (normalized.startsWith("model:") || normalized.startsWith("model-ttft:")) {
		return "llm-inference";
	}
	if (normalized.startsWith("actions:")) return "actions";
	if (normalized.includes("evaluator")) return "evaluators";
	if (
		normalized === "composestate" ||
		normalized.startsWith("provider:") ||
		normalized.startsWith("provider-cache:")
	) {
		return "providers";
	}
	if (normalized === "chat:document-augmentation") {
		return "document-augmentation";
	}
	if (normalized === "message:planner") return "planner-overhead";
	if (normalized === "chat:response-finalization") {
		return "response-finalization";
	}
	if (normalized.startsWith("message:ingress:")) {
		return "message-ingress";
	}
	if (normalized.startsWith("message:delivery:")) {
		return "message-delivery";
	}
	if (normalized.startsWith("message:lifecycle:")) {
		return "message-lifecycle";
	}
	if (
		normalized === "chat:message-service" ||
		normalized === "message-service"
	) {
		return "message-service-overhead";
	}
	return null;
}

function roundedMs(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function addMeasuredDuration(
	measurements: Map<InferenceFlowStage, number>,
	stage: InferenceFlowStage,
	durationMs: number,
): void {
	const current = measurements.get(stage);
	measurements.set(
		stage,
		current === undefined ? durationMs : current + durationMs,
	);
}

/**
 * Partitions the request timeline into exclusive stages. Nested model/provider
 * spans and parallel providers therefore never inflate the wall-clock total.
 */
export function buildInferenceFlowBreakdown(
	summary: InferenceTurnSummary,
): InferenceFlowBreakdown {
	const totalMs = summary.totalMs;
	if (totalMs === null || totalMs < 0) {
		return {
			turnId: summary.turnId,
			totalMs,
			timeToFirstVisibleMs: summary.timeToFirstVisibleMs,
			stages: [],
		};
	}

	const spans = summary.spans
		.map((span) => ({
			startMs: Math.max(0, Math.min(totalMs, span.startMs)),
			endMs: Math.max(0, Math.min(totalMs, span.endMs)),
			stage: classifyInferenceSpan(span.name),
		}))
		.filter(
			(span): span is typeof span & { stage: InferenceFlowStage } =>
				span.stage !== null && span.endMs > span.startMs,
		);
	const boundaries = new Set<number>([0, totalMs]);
	for (const span of spans) {
		boundaries.add(span.startMs);
		boundaries.add(span.endMs);
	}
	const ordered = [...boundaries].sort((left, right) => left - right);
	const totals = new Map<InferenceFlowStage, number>();
	const visibleTotals = new Map<InferenceFlowStage, number>();
	const firstVisible =
		summary.timeToFirstVisibleMs === null
			? null
			: Math.max(0, Math.min(totalMs, summary.timeToFirstVisibleMs));

	for (let index = 0; index < ordered.length - 1; index += 1) {
		const startMs = ordered[index] as number;
		const endMs = ordered[index + 1] as number;
		if (endMs <= startMs) continue;
		const midpoint = startMs + (endMs - startMs) / 2;
		const active = new Set(
			spans
				.filter((span) => span.startMs <= midpoint && midpoint < span.endMs)
				.map((span) => span.stage),
		);
		const stage =
			FLOW_STAGE_PRIORITY.find((candidate) => active.has(candidate)) ??
			"unattributed";
		const duration = endMs - startMs;
		addMeasuredDuration(totals, stage, duration);
		if (firstVisible !== null && startMs < firstVisible) {
			const visibleDuration = Math.min(endMs, firstVisible) - startMs;
			if (visibleDuration > 0) {
				addMeasuredDuration(visibleTotals, stage, visibleDuration);
			}
		}
	}

	return {
		turnId: summary.turnId,
		totalMs: roundedMs(totalMs),
		timeToFirstVisibleMs:
			firstVisible === null ? null : roundedMs(firstVisible),
		stages: INFERENCE_FLOW_STAGES.flatMap((stage) => {
			const stageTotal = totals.get(stage);
			if (stageTotal === undefined || stageTotal === 0) return [];
			const visibleStageTotal = visibleTotals.get(stage);
			return [
				{
					stage,
					totalMs: roundedMs(stageTotal),
					toFirstVisibleMs:
						firstVisible === null
							? null
							: roundedMs(
									visibleStageTotal === undefined ? 0 : visibleStageTotal,
								),
					percentOfTotal:
						totalMs === 0
							? null
							: Math.round((stageTotal / totalMs) * 10_000) / 100,
				},
			];
		}),
	};
}

// ---------------------------------------------------------------------------
// Turn timer
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SPANS = 512;

/** Shape accepted by the Cloud gateway's bounded trace-id validator. */
export const INFERENCE_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Mint a bounded, gateway-valid correlation id (32 lowercase hex). The format
 * doubles as a W3C `traceparent` trace-id, so downstream hops can adopt it
 * without re-minting.
 */
export function mintInferenceTraceId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

export class InferenceTurnTimer {
	readonly turnId: string;
	readonly traceId: string;
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
		/** Caller-propagated id (e.g. from an upstream hop); minted when absent.
		 *  Must match {@link INFERENCE_TRACE_ID_PATTERN}. */
		traceId?: string;
		label: string;
		roomId?: string | null;
		t0EpochMs?: number;
		maxSpans?: number;
	}) {
		this.turnId = args.turnId;
		if (
			args.traceId !== undefined &&
			!INFERENCE_TRACE_ID_PATTERN.test(args.traceId)
		) {
			throw new ElizaError(
				"InferenceTurnTimer: traceId must be 32 lowercase hex characters",
				{
					code: "INFERENCE_TRACE_ID_INVALID",
					severity: "fatal",
					// The id itself is caller-propagated and may be attacker-influenced,
					// so only its shape is recorded, never the value.
					context: {
						turnId: args.turnId,
						traceIdLength: args.traceId.length,
					},
				},
			);
		}
		this.traceId = args.traceId ?? mintInferenceTraceId();
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
			traceId: this.traceId,
			label: this.label,
			roomId: this.roomId,
			modelProvider: this.modelProvider,
			t0EpochMs: this.t0EpochMs,
			closedAtEpochMs: this.closedAtEpochMs,
			totalMs:
				this.closedAtEpochMs === null ? null : this.rel(this.closedAtEpochMs),
			timeToFirstTokenMs: markRel(INFERENCE_MARKS.firstToken),
			timeToFirstVisibleMs: markRel(INFERENCE_MARKS.firstVisibleReply),
			timeToReplyMs: markRel(INFERENCE_MARKS.replyDelivered),
			timeToResponseFinalizedMs: markRel(INFERENCE_MARKS.responseFinalized),
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
			// error-policy:J4 browser and edge runtimes intentionally use the
			// single-slot timing store when AsyncLocalStorage is unavailable.
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
	p95: number | null;
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
				p95: null,
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
			p95: pct(95),
			p99: pct(99),
			min: sorted[0] as number,
			max: sorted[n - 1] as number,
			mean: sum / n,
		};
	}
	reset(): void {
		this.samples.length = 0;
	}
}

const REGISTRY_RING_CAPACITY = 64;
const REGISTRY_HISTOGRAM_CAPACITY = 256;

class InferenceTimingRegistry {
	private readonly ring: InferenceTurnSummary[] = [];
	private readonly spanHistograms = new Map<string, BoundedHistogram>();
	private readonly ttft = new BoundedHistogram(REGISTRY_HISTOGRAM_CAPACITY);
	private readonly firstVisible = new BoundedHistogram(
		REGISTRY_HISTOGRAM_CAPACITY,
	);
	private readonly ttreply = new BoundedHistogram(REGISTRY_HISTOGRAM_CAPACITY);
	private readonly finalized = new BoundedHistogram(
		REGISTRY_HISTOGRAM_CAPACITY,
	);
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
		if (summary.timeToFirstVisibleMs !== null)
			this.firstVisible.add(summary.timeToFirstVisibleMs);
		if (summary.timeToReplyMs !== null) this.ttreply.add(summary.timeToReplyMs);
		if (summary.timeToResponseFinalizedMs !== null)
			this.finalized.add(summary.timeToResponseFinalizedMs);
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
			timeToFirstVisibleMs: this.firstVisible.summary(),
			timeToReplyMs: this.ttreply.summary(),
			timeToResponseFinalizedMs: this.finalized.summary(),
			totalMs: this.total.summary(),
		};
	}

	reset(): void {
		this.ring.length = 0;
		this.spanHistograms.clear();
		this.ttft.reset();
		this.firstVisible.reset();
		this.ttreply.reset();
		this.finalized.reset();
		this.total.reset();
	}
}

export const inferenceTimingRegistry = new InferenceTimingRegistry();

export interface InferenceTimingDevPayload {
	generatedAtEpochMs: number;
	turns: InferenceTurnSummary[];
	flows: InferenceFlowBreakdown[];
	spanHistograms: Record<string, InferenceHistogramSummary>;
	derivedHistograms: Record<string, InferenceHistogramSummary>;
	providers: ProviderInferenceTelemetry[];
}

export interface ProviderInferenceTelemetry {
	providerName: string;
	execution: InferenceHistogramSummary;
	cacheHits: number;
	successes: number;
	errors: number;
	aborted: number;
	coalesced: number;
	unknown: number;
}

function summarizeProviderInference(
	turns: readonly InferenceTurnSummary[],
): ProviderInferenceTelemetry[] {
	const summaries = new Map<
		string,
		{
			histogram: BoundedHistogram;
			cacheHits: number;
			successes: number;
			errors: number;
			aborted: number;
			coalesced: number;
			unknown: number;
		}
	>();
	const entryFor = (providerName: string) => {
		const existing = summaries.get(providerName);
		if (existing) return existing;
		const created = {
			histogram: new BoundedHistogram(REGISTRY_HISTOGRAM_CAPACITY),
			cacheHits: 0,
			successes: 0,
			errors: 0,
			aborted: 0,
			coalesced: 0,
			unknown: 0,
		};
		summaries.set(providerName, created);
		return created;
	};

	for (const turn of turns) {
		for (const span of turn.spans) {
			if (span.name.startsWith("provider-cache:")) {
				entryFor(span.name.slice("provider-cache:".length)).cacheHits += 1;
				continue;
			}
			if (!span.name.startsWith("provider:")) continue;
			const entry = entryFor(span.name.slice("provider:".length));
			entry.histogram.add(span.durationMs);
			if (span.meta?.coalesced === true) entry.coalesced += 1;
			switch (span.meta?.outcome) {
				case "success":
					entry.successes += 1;
					break;
				case "aborted":
					entry.aborted += 1;
					break;
				case "error":
					entry.errors += 1;
					break;
				default:
					entry.unknown += 1;
					break;
			}
		}
	}

	return [...summaries.entries()]
		.map(([providerName, entry]) => ({
			providerName,
			execution: entry.histogram.summary(),
			cacheHits: entry.cacheHits,
			successes: entry.successes,
			errors: entry.errors,
			aborted: entry.aborted,
			coalesced: entry.coalesced,
			unknown: entry.unknown,
		}))
		.sort(
			(a, b) =>
				(b.execution.p95 ?? b.execution.max ?? -1) -
					(a.execution.p95 ?? a.execution.max ?? -1) ||
				a.providerName.localeCompare(b.providerName),
		);
}

/** JSON body for a dev endpoint (e.g. `GET /api/dev/inference-timing`). */
export function buildInferenceTimingDevPayload(
	limit = 50,
	persistedTurns: readonly InferenceTurnSummary[] = [],
): InferenceTimingDevPayload {
	if (persistedTurns.length > 0) {
		const byTurnId = new Map<string, InferenceTurnSummary>();
		for (const summary of persistedTurns) byTurnId.set(summary.turnId, summary);
		for (const summary of inferenceTimingRegistry.recentTurns(
			REGISTRY_RING_CAPACITY,
		)) {
			byTurnId.set(summary.turnId, summary);
		}
		const combined = [...byTurnId.values()].sort(
			(a, b) => a.t0EpochMs - b.t0EpochMs,
		);
		const durableRegistry = new InferenceTimingRegistry();
		for (const summary of combined) durableRegistry.record(summary);
		return {
			generatedAtEpochMs: Date.now(),
			turns:
				limit >= combined.length
					? combined
					: combined.slice(combined.length - limit),
			flows: (limit >= combined.length
				? combined
				: combined.slice(combined.length - limit)
			).map(buildInferenceFlowBreakdown),
			spanHistograms: durableRegistry.spanSummaries(),
			derivedHistograms: durableRegistry.derivedSummaries(),
			providers: summarizeProviderInference(combined),
		};
	}
	const recentTurns = inferenceTimingRegistry.recentTurns(
		REGISTRY_RING_CAPACITY,
	);
	return {
		generatedAtEpochMs: Date.now(),
		turns:
			limit >= recentTurns.length
				? recentTurns
				: recentTurns.slice(recentTurns.length - limit),
		flows: (limit >= recentTurns.length
			? recentTurns
			: recentTurns.slice(recentTurns.length - limit)
		).map(buildInferenceFlowBreakdown),
		spanHistograms: inferenceTimingRegistry.spanSummaries(),
		derivedHistograms: inferenceTimingRegistry.derivedSummaries(),
		providers: summarizeProviderInference(recentTurns),
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
	if (s.timeToFirstVisibleMs !== null)
		parts.push(`ttvisible=${s.timeToFirstVisibleMs}ms`);
	if (s.timeToFirstTokenMs !== null)
		parts.push(`ttft=${s.timeToFirstTokenMs}ms`);
	if (s.timeToResponseFinalizedMs !== null)
		parts.push(`finalized=${s.timeToResponseFinalizedMs}ms`);
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
	const trace = s.traceId ? ` trace=${s.traceId}` : "";
	return `${head}${provider}${trace} ${parts.join(" ")}`;
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
		// error-policy:J7 timing diagnostics must never terminate the inference
		// path whose failure they are intended to help diagnose.
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
