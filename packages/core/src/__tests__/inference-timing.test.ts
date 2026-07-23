/**
 * Covers InferenceTurnTimer and the inference-timing AsyncLocalStorage helpers:
 * span roll-up by name, mark-derived timeToReply / timeToFirstToken,
 * duplicate-mark anomaly detection, ALS attribution across async boundaries,
 * and the emit / format / dev-payload registry. Deterministic — no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { logger } from "../logger";

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

describe("post-reply tail watchdog", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		delete process.env.ELIZA_TURN_TAIL_BUDGET_MS;
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		delete process.env.ELIZA_TURN_TAIL_BUDGET_MS;
		warnSpy.mockRestore();
	});

	/** A closed turn with reply at `replyAtMs` and total ≈ `totalMs`, plus a
	 *  span that starts after the reply mark (the billing/persistence tail). */
	const makeTailTurn = (args: {
		replyAtMs: number;
		totalMs: number;
		tailSpanMs: number;
	}) => {
		const timer = new InferenceTurnTimer({
			turnId: "tail",
			label: "message-turn",
			t0EpochMs: Date.now() - args.totalMs,
		});
		timer.mark(
			INFERENCE_MARKS.replyDelivered,
			timer.t0EpochMs + args.replyAtMs,
		);
		// recordSpan back-dates start from now, so this span's startMs lands in
		// the tail (well after replyAtMs) for realistic totals.
		timer.recordSpan("cloud.billing", args.tailSpanMs);
		return timer;
	};

	it("warns with turnId, tailMs, and the post-reply spans when the tail exceeds the budget", () => {
		const timer = makeTailTurn({
			replyAtMs: 100,
			totalMs: 3000,
			tailSpanMs: 1600,
		});
		emitInferenceTiming(timer);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [ctx, msg] = warnSpy.mock.calls[0] as [
			{
				turnId: string;
				tailMs: number;
				tailSpans: Array<{ name: string; durationMs: number }>;
			},
			string,
		];
		expect(ctx.turnId).toBe("tail");
		expect(ctx.tailMs).toBeGreaterThan(500);
		expect(ctx.tailSpans).toEqual([
			{ name: "cloud.billing", durationMs: 1600 },
		]);
		expect(msg).toContain("post-reply tail");
	});

	it("does not warn when the tail is under budget", () => {
		const timer = makeTailTurn({
			replyAtMs: 100,
			totalMs: 400,
			tailSpanMs: 200,
		});
		emitInferenceTiming(timer);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("does not warn when no reply mark was recorded (guarded no-op)", () => {
		const timer = new InferenceTurnTimer({
			turnId: "no-reply",
			label: "message-turn",
			t0EpochMs: Date.now() - 3000,
		});
		timer.recordSpan("cloud.billing", 1600);
		emitInferenceTiming(timer);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("respects ELIZA_TURN_TAIL_BUDGET_MS overrides, including 0 = disabled", () => {
		process.env.ELIZA_TURN_TAIL_BUDGET_MS = "5000";
		emitInferenceTiming(
			makeTailTurn({ replyAtMs: 100, totalMs: 3000, tailSpanMs: 1600 }),
		);
		expect(warnSpy).not.toHaveBeenCalled();

		process.env.ELIZA_TURN_TAIL_BUDGET_MS = "0";
		emitInferenceTiming(
			makeTailTurn({ replyAtMs: 100, totalMs: 3000, tailSpanMs: 1600 }),
		);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
