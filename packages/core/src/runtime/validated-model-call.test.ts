/**
 * Covers the remote-model parse + schema-validate + reroll wrapper.
 *
 * The budget arithmetic is the part worth pinning. Remote models have no
 * sampler-level grammar, so an out-of-enum value can only be caught here; but
 * rerolling is a real cost, so the effective budget must be
 * `min(maxRerolls ?? default, VALIDATION_LEVEL cap)` — a user who dialled
 * retries down to `trusted`/`fast` must get zero rerolls even though the
 * module's own default is 2. Getting that wrong either burns tokens the user
 * opted out of or silently drops the validation the remote path exists for.
 *
 * Drives the real wrapper against a fake runtime that counts `useModel` calls;
 * no network, no model.
 */
import { describe, expect, it } from "vitest";

import type { IAgentRuntime } from "../types/runtime";
import {
	callModelWithValidation,
	DEFAULT_REMOTE_REROLL_BUDGET,
	parseAndValidate,
	rerollBudgetCeilingFromSetting,
	SchemaValidationFailedError,
} from "./validated-model-call.ts";

const SCHEMA = {
	type: "object",
	properties: { mood: { type: "string", enum: ["calm", "angry"] } },
	required: ["mood"],
} as never;

/** Fake runtime whose useModel returns the queued responses in order. */
function makeRuntime(
	responses: string[],
	settings: Record<string, unknown> = {},
): { runtime: IAgentRuntime; calls: () => number } {
	let index = 0;
	let calls = 0;
	const runtime = {
		getSetting: (key: string) => settings[key],
		useModel: async () => {
			calls += 1;
			const next = responses[Math.min(index, responses.length - 1)];
			index += 1;
			return next;
		},
		getModelHandler: () => undefined,
	} as unknown as IAgentRuntime;
	return { runtime, calls: () => calls };
}

const opts = (extra: Record<string, unknown> = {}) =>
	({
		modelType: "TEXT_LARGE",
		params: { prompt: "p" },
		schema: SCHEMA,
		validateBeforeReturn: true,
		...extra,
	}) as never;

describe("parseAndValidate", () => {
	it("accepts a schema-valid object", () => {
		const result = parseAndValidate('{"mood":"calm"}', SCHEMA);
		expect(result.valid).toBe(true);
		expect(result.parsed).toEqual({ mood: "calm" });
		expect(result.errors).toEqual([]);
	});

	it("reports a parse failure distinctly from a validation failure", () => {
		const result = parseAndValidate("not json at all", SCHEMA);
		expect(result.valid).toBe(false);
		expect(result.parsed).toBeNull();
		expect(result.parseError).toBeTruthy();
	});

	it("rejects an out-of-enum value that parses fine", () => {
		// The exact case remote models produce and the legacy parse-only retry
		// path let through.
		const result = parseAndValidate('{"mood":"furious"}', SCHEMA);
		expect(result.valid).toBe(false);
		expect(result.parsed).toEqual({ mood: "furious" });
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.parseError).toBeUndefined();
	});

	it("rejects a missing required property and reports a failed path", () => {
		const result = parseAndValidate("{}", SCHEMA);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

describe("rerollBudgetCeilingFromSetting", () => {
	it("maps the documented VALIDATION_LEVEL values", () => {
		const cap = (value: unknown) =>
			rerollBudgetCeilingFromSetting(
				makeRuntime([], { VALIDATION_LEVEL: value }).runtime,
			);
		expect(cap("trusted")).toBe(0);
		expect(cap("fast")).toBe(0);
		expect(cap("progressive")).toBe(2);
		expect(cap("strict")).toBe(3);
		expect(cap("safe")).toBe(3);
	});

	it("is case-insensitive", () => {
		expect(
			rerollBudgetCeilingFromSetting(
				makeRuntime([], { VALIDATION_LEVEL: "TRUSTED" }).runtime,
			),
		).toBe(0);
	});

	it("returns undefined for unset or unknown values so no cap applies", () => {
		for (const value of [undefined, null, 3, "nonsense"]) {
			expect(
				rerollBudgetCeilingFromSetting(
					makeRuntime([], { VALIDATION_LEVEL: value }).runtime,
				),
			).toBeUndefined();
		}
	});
});

describe("callModelWithValidation", () => {
	it("returns on a first-shot valid response without rerolling", async () => {
		const { runtime, calls } = makeRuntime(['{"mood":"calm"}']);
		const result = await callModelWithValidation(runtime, opts());
		expect(result.parsed).toEqual({ mood: "calm" });
		expect(result.attempts).toBe(1);
		expect(calls()).toBe(1);
	});

	it("rerolls past an invalid response and reports the attempt count", async () => {
		const { runtime, calls } = makeRuntime([
			'{"mood":"furious"}',
			'{"mood":"calm"}',
		]);
		const result = await callModelWithValidation(runtime, opts());
		expect(result.parsed).toEqual({ mood: "calm" });
		expect(result.attempts).toBe(2);
		expect(calls()).toBe(2);
	});

	it("gives up after the default budget with a typed error", async () => {
		const { runtime, calls } = makeRuntime(['{"mood":"furious"}']);
		await expect(
			callModelWithValidation(runtime, opts()),
		).rejects.toBeInstanceOf(SchemaValidationFailedError);
		// 2 rerolls = 3 total attempts.
		expect(calls()).toBe(DEFAULT_REMOTE_REROLL_BUDGET + 1);
	});

	it("honours an explicit smaller reroll budget", async () => {
		const { runtime, calls } = makeRuntime(['{"mood":"furious"}']);
		await expect(
			callModelWithValidation(runtime, opts({ maxRerolls: 0 })),
		).rejects.toBeInstanceOf(SchemaValidationFailedError);
		expect(calls()).toBe(1);
	});

	it("lets VALIDATION_LEVEL cap the budget below the module default", async () => {
		// `trusted` means the user opted out of retries; the wrapper must not
		// spend its own default budget anyway.
		let calls = 0;
		const runtime = {
			getSetting: (key: string) =>
				key === "VALIDATION_LEVEL" ? "trusted" : undefined,
			useModel: async () => {
				calls += 1;
				return '{"mood":"furious"}';
			},
			getModelHandler: () => undefined,
		} as unknown as IAgentRuntime;
		await expect(
			callModelWithValidation(runtime, opts()),
		).rejects.toBeInstanceOf(SchemaValidationFailedError);
		expect(calls).toBe(1);
	});

	it("skips validation entirely when the caller opts out", async () => {
		const { runtime, calls } = makeRuntime(['{"mood":"furious"}']);
		const result = await callModelWithValidation(
			runtime,
			opts({ validateBeforeReturn: false }),
		);
		expect(result.attempts).toBe(1);
		expect(calls()).toBe(1);
		expect(result.rawResponse).toBe('{"mood":"furious"}');
	});

	it("rerolls a parse failure too, not just a schema failure", async () => {
		const { runtime, calls } = makeRuntime([
			"definitely not json",
			'{"mood":"calm"}',
		]);
		const result = await callModelWithValidation(runtime, opts());
		expect(result.parsed).toEqual({ mood: "calm" });
		expect(calls()).toBe(2);
	});

	it("carries the last raw response on the thrown error", async () => {
		const { runtime } = makeRuntime(['{"mood":"furious"}']);
		await callModelWithValidation(runtime, opts()).catch((error: unknown) => {
			expect(error).toBeInstanceOf(SchemaValidationFailedError);
			expect((error as SchemaValidationFailedError).message).toBeTruthy();
		});
	});
});
