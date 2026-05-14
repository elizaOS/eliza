/**
 * Remote-model "parse + schema-validate + reroll" wrapper around
 * {@link IAgentRuntime.useModel}.
 *
 * WHY THIS EXISTS:
 * For local models (e.g. eliza-1, 0.8B Qwen 3.5) we constrain output at the
 * sampler with GBNF grammars, so the model *cannot* emit out-of-schema values.
 * For remote models (Anthropic, OpenAI, Cerebras llama3.1-8b, etc.) we have no
 * such guarantee — a parse-valid response can still contain out-of-enum values
 * or wrong types. The legacy retry path in
 * {@link AgentRuntime.dynamicPromptExecFromState} only rerolls on
 * `JSON.parse` failure, so an out-of-enum string passes through and gets
 * coerced post-hoc by handler code.
 *
 * This module:
 *   1. Calls `useModel` and parses the response as JSON.
 *   2. Validates the parsed object against the supplied JSON Schema using
 *      {@link validateSchema} (the same per-arg checker used by
 *      `validateToolArgs`, lifted to a top-level "does this object satisfy
 *      the full schema" check).
 *   3. On parse OR validation failure, **rerolls up to 2 times**
 *      (3 total attempts).
 *   4. On the 3rd failure, throws {@link SchemaValidationFailedError}.
 *
 * The reroll budget applies **only to the remote path**. The gate is either:
 *   - explicit: caller passes `validateBeforeReturn: false` → no validation,
 *     no reroll (local callers should leave it false), or
 *   - automatic: the handler registered for `modelType` belongs to a provider
 *     matched by {@link isLocalProvider} → skip.
 *
 * Existing `VALIDATION_LEVEL` semantics are respected as an UPPER BOUND: if a
 * user has dialled retries down (e.g. `trusted`/`fast` → 0), the wrapper will
 * not exceed that even though its own default is 2.
 */

import { type JsonSchema, validateSchema } from "../actions/validate-tool-args";
import type {
	GenerateTextParams,
	ModelHandler,
	ModelTypeName,
	TextGenerationModelType,
} from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { isLocalProvider } from "./action-model-routing";
import { parseJsonObject } from "./json-output";

/**
 * Default reroll budget for remote-model calls. 2 rerolls = 3 total attempts.
 * Capped by {@link VALIDATION_LEVEL} when the user has set a stricter ceiling.
 */
export const DEFAULT_REMOTE_REROLL_BUDGET = 2;

/**
 * The single-attempt outcome shape returned by {@link parseAndValidate}.
 * Surfaced for callers that want to wire the parse + validate pass without
 * the retry loop (e.g. unit tests, single-shot diagnostics).
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
	 * from the leading "Argument '<path>' ..." prefix of the first error.
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
 * Thrown by {@link callModelWithValidation} after the reroll budget is
 * exhausted without producing a schema-valid response. Carries the last
 * model output (raw + parsed) and the schema-path of the first failed
 * argument so the caller can log a useful diagnosis.
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
 *   - no handler is registered for the type, or
 *   - the runtime is a mock without a `models` map.
 *
 * Used by {@link callModelWithValidation} to detect local providers (which
 * already guarantee a valid response via grammar enforcement and so skip the
 * validation reroll entirely).
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
 * Resolve whether this call should validate-before-return.
 *
 * Priority (later wins):
 *   1. Default: true (validate on the remote path).
 *   2. If the resolved provider is local, flip to false (grammar already
 *      enforces validity).
 *   3. Explicit `validateBeforeReturn` from the caller overrides everything.
 *      Local callers passing `false` is the canonical way to opt out.
 */
function shouldValidate(
	runtime: IAgentRuntime,
	modelType: ModelTypeName | string,
	explicit: boolean | undefined,
): boolean {
	if (explicit !== undefined) return explicit;
	const provider = getProviderForModelType(runtime, modelType);
	if (provider && isLocalProvider(provider)) return false;
	return true;
}

/**
 * Read the `VALIDATION_LEVEL` setting and map it to a hard upper bound on
 * the number of rerolls (NOT total attempts). Used to cap our default budget
 * when the user has dialled it down.
 *
 * Mapping mirrors {@link AgentRuntime.dynamicPromptExecFromState}:
 *   - `trusted` / `fast` → 0 rerolls
 *   - `progressive`     → 2 rerolls
 *   - `strict` / `safe` → 3 rerolls
 *   - anything else (incl. unset / unknown) → no override (returns undefined)
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
 * Options for {@link callModelWithValidation}. The wrapper is text-generation
 * focused — it expects a string response from `useModel` and parses it as
 * JSON — so the parameter shape mirrors text-model calls.
 */
export interface CallModelWithValidationOptions {
	/** Model type to dispatch to — passed straight through to `useModel`. */
	modelType: TextGenerationModelType | ModelTypeName | string;
	/** Model params — passed straight through to `useModel`. */
	params: GenerateTextParams;
	/** Optional provider hint — passed straight through to `useModel`. */
	provider?: string;
	/**
	 * JSON Schema the parsed response must satisfy when `validateBeforeReturn`
	 * is true. The same shape produced by `actionToJsonSchema` /
	 * `normalizeActionJsonSchema`.
	 */
	schema: JsonSchema;
	/**
	 * Whether to validate the parsed response against {@link schema} and
	 * reroll on failure. Default: auto-detect (true for remote providers,
	 * false for local). Local callers should pass `false` explicitly.
	 */
	validateBeforeReturn?: boolean;
	/**
	 * Maximum number of rerolls. Default {@link DEFAULT_REMOTE_REROLL_BUDGET}
	 * (= 2 rerolls, 3 total attempts). Capped by `VALIDATION_LEVEL` when the
	 * user setting yields a stricter ceiling — the EFFECTIVE budget is
	 * `min(maxRerolls ?? default, VALIDATION_LEVEL cap)`.
	 */
	maxRerolls?: number;
}

export interface CallModelWithValidationResult {
	/** The raw model response that passed validation. */
	rawResponse: string;
	/** The parsed-and-validated response object. */
	parsed: Record<string, unknown>;
	/** Number of model calls actually issued (1 = first-shot success). */
	attempts: number;
}

/**
 * Call `useModel` with schema-validation-aware retry semantics.
 *
 * See module docstring for the overall contract. The short version:
 *
 *   - Remote provider (default): parse + validate. On failure, reroll up to
 *     `maxRerolls` times (default 2). After exhausting the budget, throws
 *     {@link SchemaValidationFailedError}.
 *
 *   - Local provider: skip validation + reroll entirely (grammar at the
 *     sampler already guarantees a valid response).
 *
 *   - Caller can force either behaviour via `validateBeforeReturn`.
 *
 *   - `VALIDATION_LEVEL` from runtime settings caps the reroll budget.
 *
 * Surrounding flow (planner-loop) treats no-actions as a terminal turn, so a
 * thrown error here ends the turn cleanly — see the catch-site in
 * planner-loop for the conversion to a recorded failure.
 */
export async function callModelWithValidation(
	runtime: IAgentRuntime,
	options: CallModelWithValidationOptions,
): Promise<CallModelWithValidationResult> {
	const validate = shouldValidate(
		runtime,
		options.modelType,
		options.validateBeforeReturn,
	);
	const requestedBudget = options.maxRerolls ?? DEFAULT_REMOTE_REROLL_BUDGET;
	const ceiling = rerollBudgetCeilingFromSetting(runtime);
	const effectiveBudget =
		ceiling !== undefined
			? Math.min(requestedBudget, ceiling)
			: requestedBudget;
	const maxAttempts = effectiveBudget + 1;

	let lastRaw = "";
	let lastParsed: Record<string, unknown> | null = null;
	let lastErrors: string[] = [];
	let lastSchemaPath: string | undefined;
	let attempts = 0;

	while (attempts < maxAttempts) {
		attempts++;
		// Cast through unknown: the runtime's overloaded `useModel` signature
		// requires a concrete TextGenerationModelType to land on the
		// `Promise<string>` branch. Callers using the wrapper for text-JSON
		// schemas can pass any model-type literal that resolves to text, but
		// the type system can't see that across the generic boundary.
		const result = (await (
			runtime.useModel as (
				modelType: string,
				params: GenerateTextParams,
				provider?: string,
			) => Promise<unknown>
		)(String(options.modelType), options.params, options.provider)) as unknown;
		lastRaw = typeof result === "string" ? result : String(result ?? "");

		// Local / opted-out path: parse best-effort but don't reroll.
		// We still try to surface a parsed object to the caller for symmetry,
		// but a parse failure here is the caller's problem to handle, not
		// ours.
		if (!validate) {
			const parsed = parseJsonObject<Record<string, unknown>>(lastRaw);
			return {
				rawResponse: lastRaw,
				parsed: parsed ?? {},
				attempts,
			};
		}

		const validation = parseAndValidate(lastRaw, options.schema);
		if (validation.valid && validation.parsed) {
			return {
				rawResponse: lastRaw,
				parsed: validation.parsed,
				attempts,
			};
		}

		lastParsed = validation.parsed;
		lastErrors = validation.errors;
		lastSchemaPath = validation.failedSchemaPath;
	}

	throw new SchemaValidationFailedError({
		lastRawResponse: lastRaw,
		lastParsedResponse: lastParsed,
		errors: lastErrors,
		schemaPath: lastSchemaPath,
		attempts,
		maxAttempts,
	});
}

/**
 * Extract the first `Argument '<path>' ...` path token from an error string
 * produced by {@link validateSchema}. Best-effort: returns `undefined` when
 * the prefix is absent (e.g. for the bare "Missing required argument 'x'"
 * shape). Used solely to populate {@link SchemaValidationFailedError.schemaPath}.
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
