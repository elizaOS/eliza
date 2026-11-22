/**
 * A rate-limited extractor call waits out the refusal once and re-sends the
 * same request, like Stage 1, the planner and the evaluator. Before this, one
 * 429 on the personal assistant's create-plan call failed the action after the
 * turn's earlier model calls had already been paid for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExtractorPipeline } from "../src/actions/extractor-pipeline";
import { runWithStreamingContext } from "../src/streaming-context";
import { MODEL_PROVIDER_RESENDS } from "../src/types/model";
import type { IAgentRuntime } from "../src/types/runtime";

type Outcome = string | Error;

function scriptedRuntime(outcomes: Outcome[]) {
	const calls: Array<Record<string, unknown>> = [];
	const reportError = vi.fn();
	const runtime = {
		reportError,
		logger: { warn: () => undefined },
		useModel: async (_type: string, params: Record<string, unknown>) => {
			calls.push(params);
			const next = outcomes.shift();
			if (next instanceof Error) throw next;
			return next ?? "";
		},
	} as unknown as IAgentRuntime;
	return { runtime, calls, reportError };
}

/** An AI SDK `APICallError` shaped like a token-bucket 429. */
const rateLimited = (fields: Record<PropertyKey, unknown> = {}) =>
	Object.assign(
		new Error(
			"Too Many Requests: Tokens per minute limit exceeded - too many tokens processed.",
		),
		{ name: "AI_APICallError", statusCode: 429, ...fields },
	);

const parser = (raw: string) => (raw === "ok" ? raw : null);

const run = (runtime: IAgentRuntime, repair = false) =>
	runExtractorPipeline({
		runtime,
		prompt: "extract",
		system: "bound system",
		responseFormat: { type: "json_object" },
		parser,
		...(repair ? { buildRepairPrompt: (raw: string) => `repair ${raw}` } : {}),
	});

/** Resolves once the pipeline is waiting on a timer. */
async function untilWaiting(): Promise<void> {
	for (let turns = 0; vi.getTimerCount() === 0; turns++) {
		if (turns > 1_000) throw new Error("The pipeline never started waiting");
		await new Promise((resolve) => setImmediate(resolve));
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("runExtractorPipeline rate-limit re-send", () => {
	it("re-sends the same call once after a 429 and returns the parsed answer", async () => {
		const { runtime, calls, reportError } = scriptedRuntime([
			rateLimited(),
			"ok",
		]);
		const result = run(runtime);
		await untilWaiting();
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(result).resolves.toEqual({
			parsed: "ok",
			raw: "ok",
			repaired: false,
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(calls[0]);
		expect(calls[0]).toMatchObject({
			prompt: "extract",
			system: "bound system",
			responseFormat: { type: "json_object" },
		});
		expect(reportError).not.toHaveBeenCalled();
	});

	it("reads the 429 through the AI SDK retry envelope", async () => {
		const refusal = rateLimited();
		const envelope = Object.assign(new Error("Failed after 3 attempts."), {
			name: "AI_RetryError",
			lastError: refusal,
			errors: [refusal, refusal, refusal],
		});
		const { runtime, calls } = scriptedRuntime([envelope, "ok"]);
		const result = run(runtime);
		await untilWaiting();
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(result).resolves.toMatchObject({ parsed: "ok" });
		expect(calls).toHaveLength(2);
	});

	it("propagates the second refusal after exactly two calls", async () => {
		const first = rateLimited();
		const second = rateLimited();
		const { runtime, calls, reportError } = scriptedRuntime([
			first,
			second,
			"ok",
		]);
		const result = run(runtime);
		const settled = result.catch((error: unknown) => error);
		await untilWaiting();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(await settled).toBe(second);
		expect(calls).toHaveLength(2);
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError.mock.calls[0]?.[1]).toBe(second);
	});

	it.each<[string, Record<string, unknown>]>([
		["an explicit retryAfterMs", { retryAfterMs: 1_500 }],
		[
			"a typed gateway rate limit",
			{ rateLimit: { kind: "rate_limited", retryAfterMs: 1_500 } },
		],
		[
			"a retry-after-ms header",
			{ responseHeaders: { "retry-after-ms": "1500" } },
		],
	])("waits the refusal's own hint from %s", async (_label, fields) => {
		const { runtime, calls } = scriptedRuntime([rateLimited(fields), "ok"]);
		const result = run(runtime);
		await untilWaiting();

		await vi.advanceTimersByTimeAsync(1_499);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toMatchObject({ parsed: "ok" });
		expect(calls).toHaveLength(2);
	});

	it.each<[string, Record<string, unknown>]>([
		["no hint", {}],
		[
			"a whole-minute Retry-After",
			{ responseHeaders: { "retry-after": "60" } },
		],
		["a long explicit retryAfterMs", { retryAfterMs: 90_000 }],
	])(
		"waits at most 5 s when the refusal carries %s",
		async (_label, fields) => {
			const { runtime, calls } = scriptedRuntime([rateLimited(fields), "ok"]);
			const result = run(runtime);
			await untilWaiting();

			await vi.advanceTimersByTimeAsync(4_999);
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(result).resolves.toMatchObject({ parsed: "ok" });
			expect(calls).toHaveLength(2);
		},
	);

	it.each<[string, Error]>([
		[
			"spent credit",
			rateLimited({
				code: "insufficient_quota",
				rateLimit: { kind: "rate_limited", retryAfterMs: 10 },
			}),
		],
		[
			"an exhausted credit balance in the body",
			rateLimited({
				responseBody: JSON.stringify({
					error: { code: "credit_balance_exhausted" },
				}),
			}),
		],
		[
			"a quota refusal",
			Object.assign(new Error("token quota exceeded"), { status: 429 }),
		],
		[
			"a used-up period allowance",
			rateLimited({
				rateLimit: { kind: "rate_limited", retryAfterMs: 10, scope: "period" },
			}),
		],
		[
			"a refusal the provider adapter already re-sent",
			rateLimited({ [MODEL_PROVIDER_RESENDS]: 3 }),
		],
	])("does not re-send %s", async (_label, refusal) => {
		const { runtime, calls } = scriptedRuntime([refusal, "ok"]);

		await expect(run(runtime)).rejects.toBe(refusal);
		expect(calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each<[string, Error]>([
		[
			"a provider outage",
			Object.assign(new Error("unavailable"), {
				statusCode: 503,
				retryAfterMs: 10,
			}),
		],
		["a bad request", Object.assign(new Error("invalid"), { statusCode: 400 })],
		["a status-less failure", new Error("boom")],
		[
			"a rate limit named only in prose",
			new Error("subscription rate limit reached: session limit hit"),
		],
	])("does not re-send %s", async (_label, failure) => {
		const { runtime, calls } = scriptedRuntime([failure, "ok"]);

		await expect(run(runtime)).rejects.toBe(failure);
		expect(calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives the repair pass its own single re-send", async () => {
		const { runtime, calls } = scriptedRuntime([
			rateLimited({ retryAfterMs: 1_000 }),
			"bad",
			rateLimited({ retryAfterMs: 2_000 }),
			"ok",
		]);
		const result = run(runtime, true);
		await untilWaiting();
		await vi.advanceTimersByTimeAsync(1_000);
		await untilWaiting();
		await vi.advanceTimersByTimeAsync(2_000);

		await expect(result).resolves.toEqual({
			parsed: "ok",
			raw: "ok",
			repaired: true,
		});
		expect(calls.map((call) => call.prompt)).toEqual([
			"extract",
			"extract",
			"repair bad",
			"repair bad",
		]);
	});

	it("propagates a second repair-pass refusal after one repair re-send", async () => {
		const second = rateLimited();
		const { runtime, calls } = scriptedRuntime([
			"bad",
			rateLimited(),
			second,
			"ok",
		]);
		const settled = run(runtime, true).catch((error: unknown) => error);
		await untilWaiting();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(await settled).toBe(second);
		expect(calls.map((call) => call.prompt)).toEqual([
			"extract",
			"repair bad",
			"repair bad",
		]);
	});

	it("stops waiting when the turn is cancelled", async () => {
		const controller = new AbortController();
		const reason = new Error("turn cancelled");
		const { runtime, calls } = scriptedRuntime([rateLimited(), "ok"]);
		const settled = runWithStreamingContext(
			{ abortSignal: controller.signal },
			() => run(runtime),
		).catch((error: unknown) => error);
		await untilWaiting();
		controller.abort(reason);

		expect(await settled).toBe(reason);
		expect(calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
