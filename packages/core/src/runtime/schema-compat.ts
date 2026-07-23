/**
 * Schema-compatibility helpers for strict-grammar inference providers.
 *
 * Cerebras (and similar providers that compile JSON-schema constraints into a
 * grammar before sampling) impose constraints OpenAI does not:
 *   1. Tool-parameter root must be `type: "object"`; root `oneOf`/`anyOf`/
 *      `enum`/`not` is rejected (error: "schema must have type 'object' and
 *      not have 'oneOf'/'anyOf'/'enum'/'not' at the top level").
 *   2. Every object node must carry an explicit `properties` map (an EMPTY
 *      map is accepted): a bare `{type: "object"}` — with or without
 *      `additionalProperties` — is rejected with `Object fields require at
 *      least one of: 'properties' or 'anyOf' with a list of possible
 *      properties.` (live-bisected against api.cerebras.ai gemma-4-31b,
 *      2026-07-23).
 *   3. Under `strict: true` tools, every object node must also carry
 *      `additionalProperties: false` (`'additionalProperties' is required to
 *      be supplied and set to false.`).
 *
 * `normalizeSchemaForCerebras(schema, true)` enforces (1) by wrapping any
 * illegal-root schema under `properties.value`, and (2)+(3) by CLOSING
 * empty object schemas — `properties: {}` plus `additionalProperties: false`
 * — instead of stripping those keys. (An earlier revision deleted
 * `properties`/`required`/`additionalProperties` from empty objects, which
 * produced exactly the bare `{type:"object"}` shape rule (2) rejects: every
 * planner turn whose tool surface included a no-arg tool, e.g. the IGNORE /
 * STOP terminal sentinels, failed with a hard 400 and surfaced to the user
 * as a fabricated "something glitched" reply.)
 * Nested usage of `oneOf`/`anyOf`/`enum`/`not` is fine — only the root is
 * checked for (1).
 *
 * `sanitizeFunctionNameForCerebras` replaces invalid characters with `_`.
 * Callers should keep a `{ sanitized → original }` map and rewrite tool-call
 * names on the response.
 */

const FUNCTION_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

export function sanitizeFunctionNameForCerebras(name: string): string {
	return name.replace(FUNCTION_NAME_PATTERN, "_");
}

function hasIllegalCerebrasRoot(node: Record<string, unknown>): boolean {
	if (node.type !== "object") return true;
	if (Array.isArray(node.oneOf) && node.oneOf.length > 0) return true;
	if (Array.isArray(node.anyOf) && node.anyOf.length > 0) return true;
	if (Array.isArray(node.enum)) return true;
	if (node.not !== undefined) return true;
	return false;
}

/**
 * The strict-safe "object with no arguments" shape: Cerebras's validator
 * requires an explicit (possibly empty) `properties` map on every object node
 * and, for `strict: true` tools, `additionalProperties: false`. `required` is
 * omitted — an empty `required` is accepted but carries no information.
 */
function closedEmptyObjectSchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: false };
}

export function normalizeSchemaForCerebras(
	schema: unknown,
	isRoot = false,
): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		// Non-object root → closed empty object schema (tool without arguments).
		if (isRoot) return closedEmptyObjectSchema();
		return schema;
	}
	let node = { ...(schema as Record<string, unknown>) };

	if (isRoot && hasIllegalCerebrasRoot(node)) {
		// Wrap the original schema under properties.value so the model still
		// emits a structured payload Cerebras's grammar compiler accepts.
		// Callers that unwrap tool arguments will see { value: <original> }.
		node = {
			type: "object",
			properties: { value: schema },
			required: ["value"],
			additionalProperties: false,
		};
	}

	if (node.type === "object") {
		const props = node.properties;
		const hasProps =
			props && typeof props === "object" && Object.keys(props).length > 0;
		const hasAnyOf = Array.isArray(node.anyOf) && node.anyOf.length > 0;
		const hasOneOf = Array.isArray(node.oneOf) && node.oneOf.length > 0;
		if (!hasProps && !hasAnyOf && !hasOneOf) {
			// Close the empty object: explicit empty `properties` plus
			// `additionalProperties: false`. Deleting these keys (the previous
			// behavior) yields a bare `{type:"object"}`, which Cerebras rejects
			// with a request-fatal 400 (`Object fields require at least one of:
			// 'properties' or 'anyOf'`), and strict-mode tools additionally
			// require `additionalProperties: false` on every object node.
			node.properties = {};
			node.additionalProperties = false;
			delete node.required;
		} else if (hasProps) {
			const next: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
				next[k] = normalizeSchemaForCerebras(v);
			}
			node.properties = next;
		}
	}

	if (Array.isArray(node.anyOf)) {
		node.anyOf = node.anyOf.map((v) => normalizeSchemaForCerebras(v));
	}
	if (Array.isArray(node.oneOf)) {
		node.oneOf = node.oneOf.map((v) => normalizeSchemaForCerebras(v));
	}
	if (node.items) {
		node.items = normalizeSchemaForCerebras(node.items);
	}
	return node;
}
