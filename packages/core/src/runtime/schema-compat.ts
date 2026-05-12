/**
 * Schema-compatibility helpers for strict-grammar inference providers.
 *
 * Cerebras (and similar providers that compile JSON-schema constraints into a
 * grammar before sampling) reject object schemas that lack populated
 * `properties`/`anyOf`/`oneOf`. They also reject function names containing
 * characters outside `[a-zA-Z0-9_-]`. The OpenAI ecosystem is permissive about
 * both, so vanilla schemas built for OpenAI break on Cerebras's grammar
 * compiler.
 *
 * `normalizeSchemaForCerebras` rewrites empty-properties object schemas
 * recursively into permissive ones (drops `properties`, `required`, and
 * restrictive `additionalProperties: false`). Tool args without parameters end
 * up as `{ type: "object" }`, which Cerebras accepts.
 *
 * `sanitizeFunctionNameForCerebras` replaces invalid characters with `_`.
 * Callers should keep a `{ sanitized → original }` map and rewrite tool-call
 * names on the response.
 */

const FUNCTION_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

export function sanitizeFunctionNameForCerebras(name: string): string {
	return name.replace(FUNCTION_NAME_PATTERN, "_");
}

export function normalizeSchemaForCerebras(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return schema;
	}
	const node = { ...(schema as Record<string, unknown>) };

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
		node.anyOf = node.anyOf.map(normalizeSchemaForCerebras);
	}
	if (Array.isArray(node.oneOf)) {
		node.oneOf = node.oneOf.map(normalizeSchemaForCerebras);
	}
	if (node.items) {
		node.items = normalizeSchemaForCerebras(node.items);
	}
	return node;
}
