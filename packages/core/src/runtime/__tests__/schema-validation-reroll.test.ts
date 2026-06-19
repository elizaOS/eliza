/**
 * Schema-validation reroll — unit tests.
 *
 * Verifies the contract for {@link callModelWithValidation}:
 *
 *   1. Two invalid responses → third valid response → returns valid, 3 attempts.
 *   2. Three invalid responses → throws {@link SchemaValidationFailedError}
 *      carrying the last raw + parsed response, the failed schema path, and
 *      the attempt count (= maxAttempts).
 *   3. First-shot valid response → no reroll, attempts = 1.
 *   4. Local provider → invalid response is NOT rerolled (grammar enforcement
 *      already guarantees correctness at the sampler; double-validation only
 *      adds latency).
 *   5. `VALIDATION_LEVEL=trusted` caps the reroll budget at 0 (1 attempt
 *      total), proving the setting is respected as an UPPER BOUND.
 *   6. Explicit `validateBeforeReturn: false` overrides auto-detection,
 *      skipping validation even on a remote provider.
 */

import { describe, expect, it, vi } from "vitest";
import type { JsonSchema } from "../../actions/validate-tool-args";
import type { ModelHandler } from "../../types/model";
import { ModelType } from "../../types/model";
import type { IAgentRuntime } from "../../types/runtime";
import {
	callModelWithValidation,
	DEFAULT_REMOTE_REROLL_BUDGET,
	parseAndValidate,
	SchemaValidationFailedError,
} from "../validated-model-call";

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Tool-call shape used in these tests: `{ action: <enum>, parameters: { ... } }`
 * with a closed enum of `[REPLY, IGNORE]`. Matches the planner's per-action
 * native-tool envelope structurally, so the test exercises the same code path
 * that real remote-model outputs flow through.
 */
const PLAN_ACTION_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["REPLY", "IGNORE"] },
		parameters: { type: "object", additionalProperties: true, properties: {} },
	},
	required: ["action"],
	additionalProperties: false,
};

/**
 * Build a tiny IAgentRuntime stub with a `useModel` mock and a registered
 * model handler whose `provider` decides whether the auto-detection treats
 * this as a local or remote call.
 */
function makeRuntime(opts: {
	responses: Array<unknown>;
	provider?: string;
	validationLevel?: string;
}): { runtime: IAgentRuntime; useModel: ReturnType<typeof vi.fn> } {
	const responses = [...opts.responses];
	const provider = opts.provider ?? "anthropic";
	const handler: ModelHandler["handler"] = vi.fn(async () => "");
	const models = new Map<string, ModelHandler[]>([
		[
			ModelType.ACTION_PLANNER,
			[{ handler, provider, priority: 0, registrationOrder: 0 }],
		],
	]);
	const useModel = vi.fn(async () => {
		if (responses.length === 0) {
			throw new Error(
				"mock useModel exhausted — test expected fewer rerolls than scripted",
			);
		}
		return responses.shift();
	});
	const runtime = {
		useModel,
		models,
		getSetting: (key: string) =>
			key === "VALIDATION_LEVEL" ? opts.validationLevel : undefined,
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

const VALID_RESPONSE = JSON.stringify({
	action: "REPLY",
	parameters: { text: "ok" },
});

// out-of-enum: schema rejects `action !== REPLY|IGNORE`.
const INVALID_RESPONSE = JSON.stringify({
	action: "INVENTED_ACTION",
	parameters: {},
});

const PATTERN_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", pattern: "^task-[0-9]+$" },
	},
	required: ["id"],
	additionalProperties: false,
};

// ─── parseAndValidate ─────────────────────────────────────────────────────

describe("parseAndValidate", () => {
	it("accepts a valid response", () => {
		const result = parseAndValidate(VALID_RESPONSE, PLAN_ACTION_SCHEMA);
		expect(result.valid).toBe(true);
		expect(result.parsed).toEqual({
			action: "REPLY",
			parameters: { text: "ok" },
		});
		expect(result.errors).toEqual([]);
	});

	it("flags out-of-enum action with a useful error and schema path", () => {
		const result = parseAndValidate(INVALID_RESPONSE, PLAN_ACTION_SCHEMA);
		expect(result.valid).toBe(false);
		expect(result.parsed).toEqual({
			action: "INVENTED_ACTION",
			parameters: {},
		});
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toMatch(/INVENTED_ACTION/);
		expect(result.failedSchemaPath).toBe("action");
	});

	it("flags unparseable input as invalid with a parse error", () => {
		const result = parseAndValidate("not json at all", PLAN_ACTION_SCHEMA);
		expect(result.valid).toBe(false);
		expect(result.parsed).toBeNull();
		expect(result.parseError).toMatch(/parse/i);
		expect(result.errors[0]).toMatch(/parse/i);
	});

	it("enforces string pattern constraints even when they are not grammar-compiled", () => {
		const result = parseAndValidate(
			JSON.stringify({ id: "project-123" }),
			PATTERN_SCHEMA,
		);

		expect(result.valid).toBe(false);
		expect(result.failedSchemaPath).toBe("id");
		expect(result.errors[0]).toContain("does not match pattern ^task-[0-9]+$");
	});
});

// ─── callModelWithValidation ──────────────────────────────────────────────

describe("callModelWithValidation — remote-path reroll", () => {
	it("two invalid + one valid → returns valid result, attempts = 3", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE, INVALID_RESPONSE, VALID_RESPONSE],
		});

		const result = await callModelWithValidation(runtime, {
			modelType: ModelType.ACTION_PLANNER,
			params: { prompt: "test" },
			schema: PLAN_ACTION_SCHEMA,
		});

		expect(result.attempts).toBe(3);
		expect(result.parsed).toEqual({
			action: "REPLY",
			parameters: { text: "ok" },
		});
		expect(useModel).toHaveBeenCalledTimes(3);
	});

	it("three invalid responses → throws SchemaValidationFailedError with last response + failed path", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE, INVALID_RESPONSE, INVALID_RESPONSE],
		});

		await expect(
			callModelWithValidation(runtime, {
				modelType: ModelType.ACTION_PLANNER,
				params: { prompt: "test" },
				schema: PLAN_ACTION_SCHEMA,
			}),
		).rejects.toMatchObject({
			name: "SchemaValidationFailedError",
			attempts: DEFAULT_REMOTE_REROLL_BUDGET + 1,
			maxAttempts: DEFAULT_REMOTE_REROLL_BUDGET + 1,
			schemaPath: "action",
			lastRawResponse: INVALID_RESPONSE,
		});

		expect(useModel).toHaveBeenCalledTimes(DEFAULT_REMOTE_REROLL_BUDGET + 1);
	});

	it("three invalid responses → thrown error carries the parsed invalid payload", async () => {
		const { runtime } = makeRuntime({
			responses: [INVALID_RESPONSE, INVALID_RESPONSE, INVALID_RESPONSE],
		});

		try {
			await callModelWithValidation(runtime, {
				modelType: ModelType.ACTION_PLANNER,
				params: { prompt: "test" },
				schema: PLAN_ACTION_SCHEMA,
			});
			throw new Error("expected SchemaValidationFailedError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SchemaValidationFailedError);
			const typed = err as SchemaValidationFailedError;
			expect(typed.lastParsedResponse).toEqual({
				action: "INVENTED_ACTION",
				parameters: {},
			});
			expect(typed.errors[0]).toMatch(/INVENTED_ACTION/);
		}
	});

	it("first-shot valid → no reroll, attempts = 1", async () => {
		const { runtime, useModel } = makeRuntime({ responses: [VALID_RESPONSE] });

		const result = await callModelWithValidation(runtime, {
			modelType: ModelType.ACTION_PLANNER,
			params: { prompt: "test" },
			schema: PLAN_ACTION_SCHEMA,
		});

		expect(result.attempts).toBe(1);
		expect(result.parsed).toEqual({
			action: "REPLY",
			parameters: { text: "ok" },
		});
		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("treats unparseable responses as reroll-triggering failures", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: ["this is not json", VALID_RESPONSE],
		});

		const result = await callModelWithValidation(runtime, {
			modelType: ModelType.ACTION_PLANNER,
			params: { prompt: "test" },
			schema: PLAN_ACTION_SCHEMA,
		});

		expect(result.attempts).toBe(2);
		expect(useModel).toHaveBeenCalledTimes(2);
	});
});

// ─── local-provider gate ──────────────────────────────────────────────────

describe("callModelWithValidation — local-handler gate", () => {
	it("does NOT reroll an invalid response from a local provider", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE], // only one scripted — proves no reroll happened
			provider: "eliza-local-inference",
		});

		const result = await callModelWithValidation(runtime, {
			modelType: ModelType.ACTION_PLANNER,
			params: { prompt: "test" },
			schema: PLAN_ACTION_SCHEMA,
		});

		expect(result.attempts).toBe(1);
		expect(useModel).toHaveBeenCalledTimes(1);
		// The invalid payload still surfaces to the caller; the gate's purpose is
		// to skip the *reroll*, not to coerce the value.
		expect(result.parsed).toEqual({
			action: "INVENTED_ACTION",
			parameters: {},
		});
	});

	it("does NOT reroll when caller explicitly passes validateBeforeReturn=false", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE], // only one scripted
			provider: "anthropic",
		});

		const result = await callModelWithValidation(runtime, {
			modelType: ModelType.ACTION_PLANNER,
			params: { prompt: "test" },
			schema: PLAN_ACTION_SCHEMA,
			validateBeforeReturn: false,
		});

		expect(result.attempts).toBe(1);
		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("DOES reroll when caller forces validateBeforeReturn=true on a local provider", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE, INVALID_RESPONSE, VALID_RESPONSE],
			provider: "eliza-local-inference",
		});

		const result = await callModelWithValidation(runtime, {
			modelType: ModelType.ACTION_PLANNER,
			params: { prompt: "test" },
			schema: PLAN_ACTION_SCHEMA,
			validateBeforeReturn: true,
		});

		expect(result.attempts).toBe(3);
		expect(useModel).toHaveBeenCalledTimes(3);
	});
});

// ─── VALIDATION_LEVEL ceiling ─────────────────────────────────────────────

describe("callModelWithValidation — VALIDATION_LEVEL ceiling", () => {
	it("trusted: caps rerolls at 0 (single attempt, then throws)", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE],
			validationLevel: "trusted",
		});

		await expect(
			callModelWithValidation(runtime, {
				modelType: ModelType.ACTION_PLANNER,
				params: { prompt: "test" },
				schema: PLAN_ACTION_SCHEMA,
			}),
		).rejects.toMatchObject({
			name: "SchemaValidationFailedError",
			attempts: 1,
			maxAttempts: 1,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("fast: same as trusted — caps rerolls at 0", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE],
			validationLevel: "fast",
		});

		await expect(
			callModelWithValidation(runtime, {
				modelType: ModelType.ACTION_PLANNER,
				params: { prompt: "test" },
				schema: PLAN_ACTION_SCHEMA,
			}),
		).rejects.toBeInstanceOf(SchemaValidationFailedError);

		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("progressive: ceiling = 2 matches default budget, no observable difference", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE, INVALID_RESPONSE, VALID_RESPONSE],
			validationLevel: "progressive",
		});

		const result = await callModelWithValidation(runtime, {
			modelType: ModelType.ACTION_PLANNER,
			params: { prompt: "test" },
			schema: PLAN_ACTION_SCHEMA,
		});

		expect(result.attempts).toBe(3);
		expect(useModel).toHaveBeenCalledTimes(3);
	});

	it("ceiling caps a higher requested budget", async () => {
		const { runtime, useModel } = makeRuntime({
			responses: [INVALID_RESPONSE, INVALID_RESPONSE],
			validationLevel: "trusted", // ceiling = 0 rerolls
		});

		await expect(
			callModelWithValidation(runtime, {
				modelType: ModelType.ACTION_PLANNER,
				params: { prompt: "test" },
				schema: PLAN_ACTION_SCHEMA,
				maxRerolls: 5,
			}),
		).rejects.toMatchObject({ attempts: 1, maxAttempts: 1 });

		expect(useModel).toHaveBeenCalledTimes(1);
	});
});
