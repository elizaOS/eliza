/**
 * Covers InferenceTurnTimer and the inference-timing AsyncLocalStorage helpers:
 * span roll-up by name, mark-derived timeToReply / timeToFirstToken,
 * duplicate-mark anomaly detection, ALS attribution across async boundaries,
 * and the emit / format / dev-payload registry. Deterministic — no live model.
 */
import { describe, expect, it } from "vitest";
import {
	buildInferenceTimingDevPayload,
	emitInferenceTiming,
	formatInferenceTimingSummary,
	getInferenceTimer,
	INFERENCE_MARKS,
	InferenceTurnTimer,
	markInference,
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

	it("derives timeToReply / timeToFirstToken from marks, null when missing", () => {
		const timer = new InferenceTurnTimer({ turnId: "t2", label: "test" });
		const start = timer.t0EpochMs;
		timer.mark(INFERENCE_MARKS.firstToken, start + 10);
		timer.mark(INFERENCE_MARKS.replyDelivered, start + 25);
		const s = timer.summary();
		expect(s.timeToFirstTokenMs).toBe(10);
		expect(s.timeToReplyMs).toBe(25);

		const noMarks = new InferenceTurnTimer({
			turnId: "t3",
			label: "test",
		}).summary();
		expect(noMarks.timeToReplyMs).toBeNull();
		expect(noMarks.timeToFirstTokenMs).toBeNull();
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
		timer.mark(INFERENCE_MARKS.replyDelivered, timer.t0EpochMs + 230);
		const line = formatInferenceTimingSummary(timer.close());
		expect(line).toContain("[InferenceTiming] message-turn");
		expect(line).toContain("provider=elizaOSCloud");
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
		expect(
			payload.spanHistograms["model:RESPONSE_HANDLER"]?.count,
		).toBeGreaterThan(0);
	});

	it("emitInferenceTiming is no-op-safe for an undefined timer", () => {
		expect(emitInferenceTiming(undefined)).toBeNull();
	});
});
