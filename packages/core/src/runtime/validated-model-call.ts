/** Schema-validation helpers for JSON model output: a single parse-and-validate pass, the failure error type, and the VALIDATION_LEVEL reroll ceiling. */

import { type JsonSchema, validateSchema } from "../actions/validate-tool-args";
import type { ModelHandler, ModelTypeName } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { parseJsonObject } from "./json-output";

/**
 * Default reroll budget for remote-model calls. 2 rerolls = 3 total attempts.
 * Capped by {@link VALIDATION_LEVEL} when the user has set a stricter ceiling.
 */
export const DEFAULT_REMOTE_REROLL_BUDGET = 2;

/**
 * The single-attempt outcome shape returned by {@link parseAndValidate}.
 */
export interface ParseAndValidateResult {
	valid: boolean;
	parsed: Record<string, unknown> | null;
	parseError?: string;
	/** Empty when {@link valid} is true. */
	errors: string[];
	/**
	 * First schema-path that failed validation, if any. Useful for
	 * {@link SchemaValidationFailedError.schemaPath}. Best-effort: extracted
	 * from the leading "Argument '<path>'..." prefix of the first error.
	 */
	failedSchemaPath?: string;
}

/**
 * Parse `raw` as a single JSON object and validate it against `schema`. Empty
 * or unparseable input yields `valid: false` with a `parseError` filled in.
 * The validator is {@link validateSchema} — the same one that powers
 * `validateToolArgs`, walking the full JSON Schema including `enum`,
 * `pattern`, `minimum` / `maximum`, `required`, and `additionalProperties`.
 */
export function parseAndValidate(
	raw: string,
	schema: JsonSchema,
): ParseAndValidateResult {
	const parsed = parseJsonObject<Record<string, unknown>>(raw);
	if (!parsed) {
		return {
			valid: false,
			parsed: null,
			parseError: "Failed to parse JSON object from model response",
			errors: ["Failed to parse JSON object from model response"],
		};
	}

	const errors: string[] = [];
	validateSchema(schema, parsed, "", errors);

	if (errors.length === 0) {
		return { valid: true, parsed, errors: [] };
	}

	return {
		valid: false,
		parsed,
		errors,
		failedSchemaPath: extractFirstPath(errors[0]),
	};
}

/**
 * Thrown by callers after their reroll budget is exhausted without producing
 * a schema-valid response. Carries the last model output (raw + parsed) and
 * the schema-path of the first failed argument so the caller can log a useful
 * diagnosis.
 */
export class SchemaValidationFailedError extends Error {
	/** Last raw model response received before giving up. */
	readonly lastRawResponse: string;
	/** Last parsed object (may be null if parsing itself never succeeded). */
	readonly lastParsedResponse: Record<string, unknown> | null;
	/** All validation errors from the final attempt. */
	readonly errors: readonly string[];
	/** Schema-path of the first failing argument on the final attempt. */
	readonly schemaPath: string | undefined;
	/** Number of model calls actually issued (≤ maxAttempts). */
	readonly attempts: number;
	/** Max attempts permitted for this call (after applying VALIDATION_LEVEL cap). */
	readonly maxAttempts: number;

	constructor(args: {
		lastRawResponse: string;
		lastParsedResponse: Record<string, unknown> | null;
		errors: readonly string[];
		schemaPath: string | undefined;
		attempts: number;
		maxAttempts: number;
	}) {
		const summary = args.errors[0] ?? "no specific validation error";
		super(
			`Remote model output failed schema validation after ${args.attempts} attempts (max ${args.maxAttempts}): ${summary}`,
		);
		this.name = "SchemaValidationFailedError";
		this.lastRawResponse = args.lastRawResponse;
		this.lastParsedResponse = args.lastParsedResponse;
		this.errors = args.errors;
		this.schemaPath = args.schemaPath;
		this.attempts = args.attempts;
		this.maxAttempts = args.maxAttempts;
	}
}

/**
 * Lookup the provider name registered for `modelType` on this runtime.
 *
 * Returns `undefined` when:
 * - no handler is registered for the type, or
 * - the runtime is a mock without a `models` map.
 */
export function getProviderForModelType(
	runtime: IAgentRuntime,
	modelType: ModelTypeName | string,
): string | undefined {
	const models = (runtime as { models?: Map<string, ModelHandler[]> }).models;
	if (!models || typeof models.get !== "function") return undefined;
	const entries = models.get(String(modelType));
	if (!entries || entries.length === 0) return undefined;
	// Same priority-pick logic as resolveModelRegistration: array is already
	// sorted on register, first wins.
	const first = entries[0];
	return first?.provider;
}

/**
 * Read the `VALIDATION_LEVEL` setting and map it to a hard upper bound on
 * the number of rerolls (NOT total attempts). Used to cap our default budget
 * when the user has dialled it down.
 *
 * Mapping mirrors {@link AgentRuntime.dynamicPromptExecFromState}:
 * - `trusted` / `fast` → 0 rerolls
 * - `progressive` → 2 rerolls
 * - `strict` / `safe` → 3 rerolls
 * - anything else (incl. unset / unknown) → no override (returns undefined)
 *
 * Returns `undefined` when no cap should be applied, so callers can use
 * `Math.min(ourBudget, cap ?? ourBudget)` cleanly.
 */
export function rerollBudgetCeilingFromSetting(
	runtime: IAgentRuntime,
): number | undefined {
	const raw = (
		runtime as { getSetting?: (key: string) => unknown }
	).getSetting?.("VALIDATION_LEVEL");
	if (typeof raw !== "string") return undefined;
	switch (raw.toLowerCase()) {
		case "trusted":
		case "fast":
			return 0;
		case "progressive":
			return 2;
		case "strict":
		case "safe":
			return 3;
		default:
			return undefined;
	}
}

/**
 * Extract the first `Argument '<path>'...` path token from an error string
 * produced by {@link validateSchema}. Best-effort: returns `undefined` when
 * the prefix is absent (e.g. for the bare "Missing required argument 'x'"
 * shape). Used to populate {@link ParseAndValidateResult.failedSchemaPath}.
 */
function extractFirstPath(error: string | undefined): string | undefined {
	if (!error) return undefined;
	const argMatch = error.match(/Argument '([^']+)'/);
	if (argMatch) return argMatch[1];
	const missingMatch = error.match(/Missing required argument '([^']+)'/);
	if (missingMatch) return missingMatch[1];
	const unexpectedMatch = error.match(/Unexpected argument '([^']+)'/);
	if (unexpectedMatch) return unexpectedMatch[1];
	return undefined;
}
