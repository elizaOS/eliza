/**
 * Covers InferenceTurnTimer and the inference-timing AsyncLocalStorage helpers:
 * span roll-up by name, request-boundary milestone derivation, duplicate-mark
 * anomaly detection, ALS attribution across async boundaries, and the emit /
 * format / dev-payload registry. Deterministic — no live model.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import {
	buildInferenceFlowBreakdown,
	buildInferenceTimingDevPayload,
	emitInferenceTiming,
	formatInferenceTimingSummary,
	getInferenceTimer,
	INFERENCE_MARKS,
	INFERENCE_TRACE_ID_PATTERN,
	InferenceTurnTimer,
	inferenceTimingRegistry,
	markInference,
	mintInferenceTraceId,
	nextInferenceTurnId,
	recordInferenceSpan,
	runWithInferenceTiming,
	timeInferenceSpan,
} from "../inference-timing";

const tick = () => new Promise((r) => setTimeout(r, 2));

describe("InferenceTurnTimer", () => {
	it("rolls up span contributions by name and counts repeats", () => {
		const timer = new InferenceTurnTimer({ turnId: "t1", label: "test" });
		timer.recordSpan("composeState", 40);
		timer.recordSpan("provider:RECENT_MESSAGES", 30);
		timer.recordSpan("model:RESPONSE_HANDLER", 100);
		timer.recordSpan("model:RESPONSE_HANDLER", 50);

		const s = timer.summary();
		expect(s.byName.composeState).toEqual({ totalMs: 40, count: 1 });
		expect(s.byName["model:RESPONSE_HANDLER"]).toEqual({
			totalMs: 150,
			count: 2,
		});
	});

	it("derives request-boundary latency milestones from marks, null when missing", () => {
		const timer = new InferenceTurnTimer({ turnId: "t2", label: "test" });
		const start = timer.t0EpochMs;
		timer.mark(INFERENCE_MARKS.firstToken, start + 10);
		timer.mark(INFERENCE_MARKS.firstVisibleReply, start + 15);
		timer.mark(INFERENCE_MARKS.replyDelivered, start + 25);
		timer.mark(INFERENCE_MARKS.responseFinalized, start + 30);
		const s = timer.summary();
		expect(s.timeToFirstTokenMs).toBe(10);
		expect(s.timeToFirstVisibleMs).toBe(15);
		expect(s.timeToReplyMs).toBe(25);
		expect(s.timeToResponseFinalizedMs).toBe(30);

		const noMarks = new InferenceTurnTimer({
			turnId: "t3",
			label: "test",
		}).summary();
		expect(noMarks.timeToReplyMs).toBeNull();
		expect(noMarks.timeToFirstTokenMs).toBeNull();
		expect(noMarks.timeToFirstVisibleMs).toBeNull();
		expect(noMarks.timeToResponseFinalizedMs).toBeNull();
	});

	it("totalMs is null until close()", () => {
		const timer = new InferenceTurnTimer({ turnId: "t4", label: "test" });
		expect(timer.summary().totalMs).toBeNull();
		const closed = timer.close();
		expect(closed.totalMs).not.toBeNull();
		expect(closed.totalMs).toBeGreaterThanOrEqual(0);
	});

	it("flags a duplicate mark as an anomaly and keeps the first", () => {
		const timer = new InferenceTurnTimer({ turnId: "t5", label: "test" });
		const start = timer.t0EpochMs;
		timer.mark("x", start + 5);
		timer.mark("x", start + 99);
		const s = timer.summary();
		expect(s.marks.find((m) => m.name === "x")?.tMs).toBe(5);
		expect(s.anomalies.some((a) => a.includes("duplicate"))).toBe(true);
	});

	it("openSpan closer is idempotent", async () => {
		const timer = new InferenceTurnTimer({ turnId: "t6", label: "test" });
		const close = timer.openSpan("work");
		await tick();
		close();
		close(); // second call must be ignored
		expect(timer.summary().byName.work.count).toBe(1);
	});

	it("setModelProvider keeps the first non-empty writer", () => {
		const timer = new InferenceTurnTimer({ turnId: "t7", label: "test" });
		timer.setModelProvider(undefined);
		timer.setModelProvider("elizaOSCloud");
		timer.setModelProvider("other");
		expect(timer.summary().modelProvider).toBe("elizaOSCloud");
	});

	it("preserves arbitrary meta (e.g. reasoningTokens) on a recorded span", () => {
		// A reasoning burst must be attributable per model call (#16394): the
		// span meta is where the runtime threads reasoningTokens, and it must
		// round-trip through the summary unchanged.
		const timer = new InferenceTurnTimer({ turnId: "t8", label: "test" });
		timer.recordSpan("model:RESPONSE_HANDLER", 3200, {
			modelKey: "zai-glm-4.7",
			provider: "cerebras",
			outcome: "success",
			reasoningTokens: 400,
		});
		// A span with no reasoning meta omits the field entirely (missing stays
		// missing, never zero).
		timer.recordSpan("model:TEXT_SMALL", 120, {
			modelKey: "zai-glm-4.7",
			provider: "cerebras",
			outcome: "success",
		});
		const s = timer.summary();
		const reasoningSpan = s.spans.find(
			(sp) => sp.name === "model:RESPONSE_HANDLER",
		);
		const plainSpan = s.spans.find((sp) => sp.name === "model:TEXT_SMALL");
		expect(reasoningSpan?.meta?.reasoningTokens).toBe(400);
		expect(plainSpan?.meta?.reasoningTokens).toBeUndefined();
	});
});

describe("exclusive inference flow breakdown", () => {
	it("partitions nested and parallel spans without double-counting", () => {
		const summary = {
			turnId: "flow",
			label: "chat-request",
			roomId: null,
			modelProvider: "test",
			t0EpochMs: 0,
			closedAtEpochMs: 100,
			totalMs: 100,
			timeToFirstTokenMs: 65,
			timeToFirstVisibleMs: 80,
			timeToReplyMs: 85,
			timeToResponseFinalizedMs: 95,
			spans: [
				{
					name: "chat:message-service",
					startMs: 10,
					endMs: 90,
					durationMs: 80,
				},
				{
					name: "message:ingress:persistence",
					startMs: 10,
					endMs: 15,
					durationMs: 5,
				},
				{
					name: "message:lifecycle:run-started",
					startMs: 15,
					endMs: 20,
					durationMs: 5,
				},
				{
					name: "composeState",
					startMs: 20,
					endMs: 50,
					durationMs: 30,
				},
				{
					name: "provider:A",
					startMs: 20,
					endMs: 45,
					durationMs: 25,
				},
				{
					name: "provider:B",
					startMs: 25,
					endMs: 50,
					durationMs: 25,
				},
				{
					name: "model:RESPONSE_HANDLER",
					startMs: 50,
					endMs: 75,
					durationMs: 25,
				},
				{
					name: "model-postprocess:RESPONSE_HANDLER",
					startMs: 75,
					endMs: 80,
					durationMs: 5,
				},
				{
					name: "message:planner",
					startMs: 80,
					endMs: 90,
					durationMs: 10,
				},
				{
					name: "actions:planner-tool",
					startMs: 80,
					endMs: 83,
					durationMs: 3,
				},
				{
					name: "evaluators:planner",
					startMs: 83,
					endMs: 85,
					durationMs: 2,
				},
				{
					name: "message:delivery:persistence",
					startMs: 85,
					endMs: 88,
					durationMs: 3,
				},
				{
					name: "message:lifecycle:run-ended",
					startMs: 88,
					endMs: 90,
					durationMs: 2,
				},
				{
					name: "chat:response-finalization",
					startMs: 90,
					endMs: 95,
					durationMs: 5,
				},
			],
			marks: [],
			byName: {},
			anomalies: [],
		} satisfies InferenceTurnSummary;

		const flow = buildInferenceFlowBreakdown(summary);
		expect(flow.stages.reduce((total, stage) => total + stage.totalMs, 0)).toBe(
			100,
		);
		expect(
			flow.stages.find((stage) => stage.stage === "providers")?.totalMs,
		).toBe(30);
		expect(
			flow.stages.find((stage) => stage.stage === "llm-inference")?.totalMs,
		).toBe(25);
		expect(
			flow.stages.find((stage) => stage.stage === "actions")?.totalMs,
		).toBe(3);
		expect(
			flow.stages.find((stage) => stage.stage === "evaluators")?.totalMs,
		).toBe(2);
		expect(
			flow.stages.find((stage) => stage.stage === "planner-overhead")?.totalMs,
		).toBeUndefined();
		expect(
			flow.stages.find((stage) => stage.stage === "message-ingress")?.totalMs,
		).toBe(5);
		expect(
			flow.stages.find((stage) => stage.stage === "message-delivery")?.totalMs,
		).toBe(3);
		expect(
			flow.stages.find((stage) => stage.stage === "message-lifecycle")?.totalMs,
		).toBe(7);
		expect(
			flow.stages.find((stage) => stage.stage === "unattributed")?.totalMs,
		).toBe(15);
		expect(
			flow.stages.reduce(
				(total, stage) =>
					total +
					(stage.toFirstVisibleMs === null ? 0 : stage.toFirstVisibleMs),
				0,
			),
		).toBe(80);
	});

	it("attributes Stage-1 preparation and orchestration instead of charging the message-service parent", () => {
		const summary = {
			turnId: "stage1-attribution",
			label: "chat-request",
			roomId: null,
			modelProvider: "test",
			t0EpochMs: 0,
			closedAtEpochMs: 20,
			totalMs: 20,
			timeToFirstTokenMs: null,
			timeToFirstVisibleMs: null,
			timeToReplyMs: null,
			timeToResponseFinalizedMs: 20,
			spans: [
				{
					name: "chat:message-service",
					startMs: 0,
					endMs: 20,
					durationMs: 20,
				},
				{
					name: "message:planner",
					startMs: 0,
					endMs: 20,
					durationMs: 20,
				},
				{
					name: "message:stage1:preprocess",
					startMs: 2,
					endMs: 8,
					durationMs: 6,
				},
			],
			marks: [],
			byName: {},
			anomalies: [],
		} satisfies InferenceTurnSummary;

		const flow = buildInferenceFlowBreakdown(summary);
		expect(
			flow.stages.find((stage) => stage.stage === "model-preprocess")?.totalMs,
		).toBe(6);
		expect(
			flow.stages.find((stage) => stage.stage === "planner-overhead")?.totalMs,
		).toBe(14);
		expect(
			flow.stages.find((stage) => stage.stage === "message-service-overhead"),
		).toBeUndefined();
	});
});

describe("inference-timing ALS helpers", () => {
	it("are no-ops with no active timer (and still run the fn)", async () => {
		expect(getInferenceTimer()).toBeUndefined();
		markInference("orphan");
		recordInferenceSpan("orphan", 5);
		const v = await timeInferenceSpan("orphan", async () => 42);
		expect(v).toBe(42);
	});

	it("attribute spans/marks to the active timer across async work", async () => {
		const timer = new InferenceTurnTimer({ turnId: "als", label: "test" });
		const out = await runWithInferenceTiming(timer, async () => {
			expect(getInferenceTimer()).toBe(timer);
			await timeInferenceSpan("composeState", async () => {
				await tick();
			});
			// Nested async boundary still sees the timer (AsyncLocalStorage).
			await Promise.resolve().then(() => {
				recordInferenceSpan("model:TEXT_SMALL", 12, { provider: "x" });
				markInference(INFERENCE_MARKS.replyDelivered);
			});
			return "done";
		});
		expect(out).toBe("done");
		const s = timer.summary();
		expect(s.byName.composeState?.count).toBe(1);
		expect(s.byName["model:TEXT_SMALL"]?.totalMs).toBe(12);
		expect(s.timeToReplyMs).not.toBeNull();
	});

	it("restores the prior timer after the scope exits", async () => {
		const outer = new InferenceTurnTimer({ turnId: "outer", label: "o" });
		await runWithInferenceTiming(outer, async () => {
			const inner = new InferenceTurnTimer({ turnId: "inner", label: "i" });
			await runWithInferenceTiming(inner, async () => {
				expect(getInferenceTimer()).toBe(inner);
			});
			expect(getInferenceTimer()).toBe(outer);
		});
		expect(getInferenceTimer()).toBeUndefined();
	});
});

describe("emit + format + registry", () => {
	it("formats a compact breakdown line ranked by contribution", () => {
		const timer = new InferenceTurnTimer({
			turnId: "fmt",
			label: "message-turn",
		});
		timer.setModelProvider("elizaOSCloud");
		timer.recordSpan("composeState", 20);
		timer.recordSpan("model:RESPONSE_HANDLER", 200);
		timer.mark(INFERENCE_MARKS.firstVisibleReply, timer.t0EpochMs + 215);
		timer.mark(INFERENCE_MARKS.replyDelivered, timer.t0EpochMs + 230);
		timer.mark(INFERENCE_MARKS.responseFinalized, timer.t0EpochMs + 240);
		const line = formatInferenceTimingSummary(timer.close());
		expect(line).toContain("[InferenceTiming] message-turn");
		expect(line).toContain("provider=elizaOSCloud");
		expect(line).toContain("ttvisible=215ms");
		expect(line).toContain("finalized=240ms");
		expect(line).toContain("model:RESPONSE_HANDLER=200ms");
		// Biggest contributor is ordered before the smaller one.
		expect(line.indexOf("model:RESPONSE_HANDLER")).toBeLessThan(
			line.indexOf("composeState"),
		);
	});

	it("emitInferenceTiming records the turn into the dev payload", () => {
		const turnId = nextInferenceTurnId();
		const timer = new InferenceTurnTimer({ turnId, label: "message-turn" });
		timer.recordSpan("model:RESPONSE_HANDLER", 77);
		emitInferenceTiming(timer);
		const payload = buildInferenceTimingDevPayload();
		expect(payload.turns.some((t) => t.turnId === turnId)).toBe(true);
		expect(payload.flows.some((flow) => flow.turnId === turnId)).toBe(true);
		expect(
			payload.spanHistograms["model:RESPONSE_HANDLER"]?.count,
		).toBeGreaterThan(0);
	});

	it("clears derived histograms together with turns and spans on reset", () => {
		inferenceTimingRegistry.reset();
		const timer = new InferenceTurnTimer({
			turnId: "reset-derived",
			label: "message-turn",
		});
		timer.recordSpan("model:RESPONSE_HANDLER", 77);
		timer.mark(INFERENCE_MARKS.firstToken, timer.t0EpochMs + 10);
		timer.mark(INFERENCE_MARKS.firstVisibleReply, timer.t0EpochMs + 20);
		timer.mark(INFERENCE_MARKS.replyDelivered, timer.t0EpochMs + 30);
		timer.mark(INFERENCE_MARKS.responseFinalized, timer.t0EpochMs + 40);
		inferenceTimingRegistry.record(timer.close());
		expect(
			buildInferenceTimingDevPayload().derivedHistograms.timeToFirstTokenMs
				?.count,
		).toBe(1);

		inferenceTimingRegistry.reset();
		const payload = buildInferenceTimingDevPayload();
		expect(payload.turns).toEqual([]);
		expect(payload.spanHistograms).toEqual({});
		expect(
			Object.values(payload.derivedHistograms).every(
				(summary) => summary.count === 0,
			),
		).toBe(true);
	});

	it("emitInferenceTiming is no-op-safe for an undefined timer", () => {
		expect(emitInferenceTiming(undefined)).toBeNull();
	});

	it("serves durable summaries beyond the 64-turn process cache", () => {
		const persisted = Array.from({ length: 100 }, (_, index) => {
			const timer = new InferenceTurnTimer({
				turnId: `persisted-${index}`,
				label: "message-turn",
				t0EpochMs: Date.now() + 100_000 + index,
			});
			timer.recordSpan("provider:FACTS", index + 1);
			return timer.close();
		});

		const payload = buildInferenceTimingDevPayload(80, persisted);

		expect(payload.turns).toHaveLength(80);
		expect(payload.turns.at(-1)?.turnId).toBe("persisted-99");
		expect(payload.spanHistograms["provider:FACTS"]?.count).toBe(100);
		expect(payload.spanHistograms["provider:FACTS"]?.p95).toBe(95);
		expect(
			payload.providers.find((entry) => entry.providerName === "FACTS"),
		).toEqual(
			expect.objectContaining({
				unknown: 100,
				cacheHits: 0,
				execution: expect.objectContaining({ count: 100, p95: 95 }),
			}),
		);
	});

	it("ranks providers by p95 and aggregates outcomes, cache hits, and coalescing", () => {
		const timer = new InferenceTurnTimer({
			turnId: "provider-telemetry",
			label: "message-turn",
			t0EpochMs: Date.now() + 200_000,
		});
		timer.recordSpan("provider:FAST", 5, {
			outcome: "success",
			coalesced: false,
		});
		timer.recordSpan("provider:SLOW", 120, {
			outcome: "error",
			coalesced: true,
		});
		timer.recordSpan("provider-cache:FAST", 0, { cacheHit: true });

		const payload = buildInferenceTimingDevPayload(50, [timer.close()]);
		expect(payload.providers.map((entry) => entry.providerName)).toEqual([
			"SLOW",
			"FAST",
		]);
		expect(payload.providers[0]).toEqual(
			expect.objectContaining({
				providerName: "SLOW",
				errors: 1,
				coalesced: 1,
				execution: expect.objectContaining({ p95: 120 }),
			}),
		);
		expect(payload.providers[1]).toEqual(
			expect.objectContaining({
				providerName: "FAST",
				successes: 1,
				cacheHits: 1,
				execution: expect.objectContaining({ p95: 5 }),
			}),
		);
	});
});

describe("turn trace correlation (#16079)", () => {
	it("mints a distinct 32-lowercase-hex trace id per turn", () => {
		const a = new InferenceTurnTimer({ turnId: "trace-a", label: "test" });
		const b = new InferenceTurnTimer({ turnId: "trace-b", label: "test" });
		expect(a.traceId).toMatch(INFERENCE_TRACE_ID_PATTERN);
		expect(b.traceId).toMatch(INFERENCE_TRACE_ID_PATTERN);
		expect(a.traceId).not.toBe(b.traceId);
	});

	it("adopts a caller-propagated trace id and rejects malformed ones", () => {
		const upstream = mintInferenceTraceId();
		const timer = new InferenceTurnTimer({
			turnId: "trace-c",
			traceId: upstream,
			label: "test",
		});
		expect(timer.traceId).toBe(upstream);

		// Rejection is a structured domain failure, not a bare Error: callers
		// classify on the code, and the raw caller-supplied id must never be
		// echoed back into the error context.
		for (const [turnId, bad] of [
			["trace-bad-shape", "not-a-trace-id"],
			["trace-bad-case", "A".repeat(32)],
			["trace-too-long", `${upstream}0`],
			["trace-too-short", upstream.slice(0, 31)],
			["trace-empty", ""],
		] as const) {
			let thrown: unknown;
			try {
				new InferenceTurnTimer({ turnId, traceId: bad, label: "test" });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ElizaError);
			const elizaError = thrown as ElizaError;
			expect(elizaError.code).toBe("INFERENCE_TRACE_ID_INVALID");
			expect(elizaError.severity).toBe("fatal");
			expect(elizaError.context).toEqual({
				turnId,
				traceIdLength: bad.length,
			});
			if (bad !== "") {
				expect(JSON.stringify(elizaError.context)).not.toContain(bad);
				expect(elizaError.message).not.toContain(bad);
			}
		}
	});

	it("carries the trace id into the summary and formatted line", () => {
		const timer = new InferenceTurnTimer({ turnId: "trace-f", label: "test" });
		const s = timer.close();
		expect(s.traceId).toBe(timer.traceId);
		expect(formatInferenceTimingSummary(s)).toContain(`trace=${timer.traceId}`);
	});

	it("exposes the active turn's trace id through the ALS context", () => {
		const timer = new InferenceTurnTimer({ turnId: "trace-g", label: "test" });
		runWithInferenceTiming(timer, () => {
			expect(getInferenceTimer()?.traceId).toBe(timer.traceId);
		});
		expect(getInferenceTimer()).toBeUndefined();
	});
});
