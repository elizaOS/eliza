/**
 * Provider compatibility for JSON-schema tool grammars and function names.
 *
 * Cerebras requires an object root and an explicit properties map on every
 * object node. The normalizer walks every standard schema-bearing keyword so
 * hoisted definitions, conditionals, tuples, and map schemas cannot bypass the
 * wire contract.
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

const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
const SCHEMA_SINGLE_KEYS = [
	"contains",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"contentSchema",
	"additionalItems",
] as const;
const SCHEMA_MAP_KEYS = [
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
] as const;

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectSchemaNeedsProperties(node: Record<string, unknown>): boolean {
	const type = node.type;
	const includesObject =
		type === "object" ||
		(Array.isArray(type) && type.includes("object")) ||
		"properties" in node ||
		"patternProperties" in node ||
		"additionalProperties" in node ||
		"dependentSchemas" in node;
	if (!includesObject) return false;
	const properties = node.properties;
	const hasProperties =
		isSchemaRecord(properties) && Object.keys(properties).length > 0;
	const hasAnyOf = Array.isArray(node.anyOf) && node.anyOf.length > 0;
	return !hasProperties && !hasAnyOf;
}

function walkSchemaChildren(node: Record<string, unknown>): void {
	for (const key of SCHEMA_MAP_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = Object.fromEntries(
			Object.entries(value).map(([name, schema]) => [
				name,
				normalizeSchemaForCerebras(schema),
			]),
		);
	}

	for (const key of SCHEMA_ARRAY_KEYS) {
		const value = node[key];
		if (!Array.isArray(value)) continue;
		node[key] = value.map((schema) => normalizeSchemaForCerebras(schema));
	}

	const items = node.items;
	if (Array.isArray(items)) {
		node.items = items.map((schema) => normalizeSchemaForCerebras(schema));
	} else if (items !== undefined) {
		node.items = normalizeSchemaForCerebras(items);
	}

	for (const key of SCHEMA_SINGLE_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = normalizeSchemaForCerebras(value);
	}

	const dependencies = node.dependencies;
	if (isSchemaRecord(dependencies)) {
		node.dependencies = Object.fromEntries(
			Object.entries(dependencies).map(([name, dependency]) => [
				name,
				Array.isArray(dependency)
					? [...dependency]
					: normalizeSchemaForCerebras(dependency),
			]),
		);
	}
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

	if (objectSchemaNeedsProperties(node)) {
		node.properties = {};
		node.additionalProperties = false;
		delete node.required;
	}

	walkSchemaChildren(node);
	return node;
}
