/**
 * Provider-agnostic optional-parameter accounting for JSON schemas.
 *
 * Several structured-output providers compile the response/tool schema into a
 * decoding grammar and cap the number of OPTIONAL (non-`required`) parameters a
 * single request may carry, because each optional field roughly doubles the
 * grammar's branching. Anthropic is the strictest known ceiling today: at most
 * 24 optional parameters counted recursively across every strict tool / the
 * structured-output schema in one request (see #16499 — the tool path was
 * budgeted there; the structured-output/evaluator path was not, which is why an
 * over-budget merged evaluator schema hard-400s every post-turn evaluation with
 * `Schemas contains too many optional parameters (N) ... (limit: 24)`).
 *
 * This module is the single source of truth for "how a grammar compiler counts
 * optional parameters" so the anthropic plugin and the assistant evaluator
 * agree without either importing the other. The number matches the provider's
 * own accounting: every property NOT listed in its object's `required`, recursed
 * into nested object `properties` and array `items` (nested optionals count
 * toward the same request-wide budget).
 */
import { isObjectRecord } from "./utils/type-guards.ts";

/**
 * Anthropic's server-enforced grammar-compilation ceiling on optional
 * parameters counted across all strict tool schemas / the structured-output
 * schema in one request. It is the strictest known provider limit, so it is the
 * safe default budget for a provider-neutral pre-flight guard.
 */
export const DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT = 24;

/** Schema keywords whose value is a nested schema the compiler descends into. */
const NESTED_SCHEMA_KEYS = [
	"items",
	"additionalProperties",
	"additionalItems",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
	"unevaluatedProperties",
	"unevaluatedItems",
] as const;
/** Schema keywords whose value is an array OR map of nested schemas. */
const NESTED_SCHEMA_COLLECTION_KEYS = [
	"anyOf",
	"oneOf",
	"allOf",
	"prefixItems",
	"$defs",
	"definitions",
	"patternProperties",
	"dependentSchemas",
] as const;

/**
 * Count optional (non-`required`) parameters the way a structured-output grammar
 * compiler counts them: every property not present in its object's `required`
 * list, recursing through EVERY nested schema position — object `properties`,
 * array `items`/`prefixItems`, and the composition keywords
 * (`anyOf`/`oneOf`/`allOf`, `$defs`, `patternProperties`, conditional
 * `if`/`then`/`else`, etc.). The optional fields inside `anyOf` branches are the
 * dominant contributor for the evaluator schemas (each extractor op is an
 * `anyOf` of operation objects), so a counter that stops at `properties`/`items`
 * badly under-counts and would let an over-budget request through. Nested
 * optionals count toward the same total. Non-object inputs contribute 0.
 */
export function countSchemaOptionalParameters(schema: unknown): number {
	if (!isObjectRecord(schema)) return 0;
	let count = 0;
	const properties = isObjectRecord(schema.properties)
		? schema.properties
		: undefined;
	if (properties) {
		const required = new Set(
			Array.isArray(schema.required)
				? (schema.required as unknown[]).map(String)
				: [],
		);
		for (const [key, child] of Object.entries(properties)) {
			if (!required.has(key)) count += 1;
			count += countSchemaOptionalParameters(child);
		}
	}
	for (const key of NESTED_SCHEMA_KEYS) {
		const child = schema[key];
		if (Array.isArray(child)) {
			for (const item of child) count += countSchemaOptionalParameters(item);
		} else {
			count += countSchemaOptionalParameters(child);
		}
	}
	for (const key of NESTED_SCHEMA_COLLECTION_KEYS) {
		const child = schema[key];
		if (Array.isArray(child)) {
			for (const item of child) count += countSchemaOptionalParameters(item);
		} else if (isObjectRecord(child)) {
			for (const item of Object.values(child)) {
				count += countSchemaOptionalParameters(item);
			}
		}
	}
	return count;
}

/**
 * Whether a schema's recursive optional-parameter count exceeds `limit`
 * (default {@link DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT}). Callers use
 * this to skip a doomed strict/structured request that the provider would
 * hard-400, degrading to a plain JSON request instead of paying for the wasted
 * round-trip every turn.
 */
export function schemaExceedsOptionalParameterLimit(
	schema: unknown,
	limit: number = DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT,
): boolean {
	return countSchemaOptionalParameters(schema) > limit;
}
