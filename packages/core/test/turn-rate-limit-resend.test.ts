/**
 * The wait before the one re-send a chat turn's Stage 1, planner, evaluator or
 * extractor makes of a rate-limited call, or none. A refusal the provider
 * adapter already re-sent gets none, wherever the stamp sits in the wrapped
 * error, and neither does another registration's 429 that ends the same call:
 * the turn's re-send would start a fresh adapter budget.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	TURN_RATE_LIMIT_RESEND_MAX_WAIT_MS,
	turnRateLimitResendWaitMs,
} from "../src/security/model-failure.ts";
import { MODEL_PROVIDER_RESENDS, ModelType } from "../src/types/model.ts";

const rateLimited = (fields: Record<PropertyKey, unknown> = {}) =>
	Object.assign(new Error("Too Many Requests"), { status: 429, ...fields });
/** The typed wait the Cloud gateway attaches to its 429. */
const reportedWait = (retryAfterMs: number, scope?: string) => ({
	rateLimit: {
		kind: "rate_limited",
		retryAfterMs,
		...(scope ? { scope } : {}),
	},
});
/** A provider that answers a token-bucket 429 with a whole-minute header. */
const minuteHeader = { responseHeaders: { "retry-after": "60" } };
/** plugin-openai's lane re-sent the request three times before it gave up. */
const resent = () => rateLimited({ [MODEL_PROVIDER_RESENDS]: 3 });

describe("turnRateLimitResendWaitMs", () => {
	it.each<[string, unknown, number]>([
		["the Cloud report", rateLimited(reportedWait(1_200)), 1_200],
		["a provider retry delay", rateLimited({ retryAfterMs: 300 }), 300],
		[
			"a retry header beyond the bound",
			rateLimited(minuteHeader),
			TURN_RATE_LIMIT_RESEND_MAX_WAIT_MS,
		],
		["no hint", rateLimited(), TURN_RATE_LIMIT_RESEND_MAX_WAIT_MS],
		[
			"a wrapped provider error",
			{ lastError: rateLimited() },
			TURN_RATE_LIMIT_RESEND_MAX_WAIT_MS,
		],
		[
			"a refusal of the adapter's first attempt",
			rateLimited({ [MODEL_PROVIDER_RESENDS]: 0 }),
			TURN_RATE_LIMIT_RESEND_MAX_WAIT_MS,
		],
	])("waits for %s, at most the bound", (_label, error, expected) => {
		expect(turnRateLimitResendWaitMs(error)).toBe(expected);
	});

	it.each<[string, unknown]>([
		[
			"spent credit",
			rateLimited({ code: "insufficient_quota", ...reportedWait(10) }),
		],
		[
			"a quota refusal",
			Object.assign(new Error("token quota exceeded"), { status: 429 }),
		],
		["a used-up period allowance", rateLimited(reportedWait(10, "period"))],
		[
			"a rate limit named only in prose",
			new Error("subscription rate limit reached: session limit hit"),
		],
		[
			"a provider outage",
			Object.assign(new Error("unavailable"), {
				status: 503,
				...reportedWait(10),
			}),
		],
		["a refusal the adapter already re-sent", resent()],
		[
			"a re-sent refusal with a short hint",
			rateLimited({ retryAfterMs: 300, [MODEL_PROVIDER_RESENDS]: 1 }),
		],
		[
			"a re-sent refusal on the cause of a dispatch error",
			new Error('Model provider "openai" failed', { cause: resent() }),
		],
		["a re-sent refusal in a retry envelope", { lastError: resent() }],
		["a re-sent refusal in an errors list", { errors: [resent()] }],
	])("does not wait for %s", (_label, error) => {
		expect(turnRateLimitResendWaitMs(error)).toBeUndefined();
	});
});

describe("a call another registration's 429 ends", () => {
	// Two text providers on one runtime, as on a desktop host with two keys:
	// "adapter" is tried first and re-sends inside its handler; "other" refuses
	// its only request. Dispatch rethrows "other"'s refusal.
	let runtime: ReturnType<typeof createSQLiteTestRuntime>;
	let adapterRefusal: Error;
	let otherRefusal: Error;

	beforeAll(async () => {
		runtime = createSQLiteTestRuntime({
			character: { name: "ResendCarry", bio: ["test"], settings: {} },
			logLevel: "fatal",
		});
		await runtime.initialize({ skipMigrations: true });
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				throw adapterRefusal;
			},
			"adapter",
			20,
		);
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				throw otherRefusal;
			},
			"other",
			10,
		);
	}, 60_000);

	afterAll(async () => {
		await runtime?.stop();
		await runtime?.close();
	});

	/** The error useModel rejects with when the adapter refuses with `adapter`. */
	const refusal = (adapter: Error) => {
		adapterRefusal = adapter;
		otherRefusal = rateLimited({ provider: "other" });
		return runtime
			.useModel(ModelType.TEXT_SMALL, { prompt: "Reply briefly." })
			.then(
				() => {
					throw new Error("expected both providers to refuse");
				},
				(error: unknown) => error,
			);
	};

	it("carries the adapter's re-send count, so the turn adds no re-send", async () => {
		const error = await refusal(resent());
		expect(error).toBe(otherRefusal);
		expect((error as Record<symbol, unknown>)[MODEL_PROVIDER_RESENDS]).toBe(3);
		expect(turnRateLimitResendWaitMs(error)).toBeUndefined();
	});

	it("keeps the turn's re-send when no provider re-sent", async () => {
		const error = await refusal(rateLimited());
		expect(error).toBe(otherRefusal);
		expect(turnRateLimitResendWaitMs(error)).toBe(
			TURN_RATE_LIMIT_RESEND_MAX_WAIT_MS,
		);
	});
});
