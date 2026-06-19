/**
 * Schema-compatibility helpers for strict-grammar inference providers.
 *
 * Cerebras (and similar providers that compile JSON-schema constraints into a
 * grammar before sampling) impose two constraints OpenAI does not:
 *   1. Tool-parameter root must be `type: "object"`; root `oneOf`/`anyOf`/
 *      `enum`/`not` is rejected (error: "schema must have type 'object' and
 *      not have 'oneOf'/'anyOf'/'enum'/'not' at the top level").
 *   2. Empty-properties object schemas are rejected by the grammar compiler.
 *
 * `normalizeSchemaForCerebras(schema, true)` enforces (1) by wrapping any
 * illegal-root schema under `properties.value`, and enforces (2) by dropping
 * `properties`/`required`/`additionalProperties` when properties is empty.
 * Nested usage of `oneOf`/`anyOf`/`enum`/`not` is fine — only the root is
 * checked.
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

export function normalizeSchemaForCerebras(
	schema: unknown,
	isRoot = false,
): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		// Non-object root → empty object schema (tool without arguments).
		if (isRoot) return { type: "object" };
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
			delete node.properties;
			delete node.required;
			delete node.additionalProperties;
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
