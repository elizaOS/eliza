/**
 * Provider compatibility for JSON-schema tool grammars and function names.
 *
 * Cerebras requires an object root and, in strict mode, closes every object
 * with `additionalProperties: false`. The normalizer walks every standard
 * schema-bearing keyword so hoisted definitions, conditionals, tuples, and map
 * schemas cannot bypass the wire contract while non-strict schemas retain
 * their permissive semantics.
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

const OBJECT_SCHEMA_KEYS = [
	"properties",
	"patternProperties",
	"additionalProperties",
	"required",
	"dependentSchemas",
	"dependentRequired",
	"dependencies",
	"propertyNames",
	"minProperties",
	"maxProperties",
	"unevaluatedProperties",
] as const;

function describesObjectSchema(node: Record<string, unknown>): boolean {
	const type = node.type;
	return (
		type === "object" ||
		(Array.isArray(type) && type.includes("object")) ||
		OBJECT_SCHEMA_KEYS.some((key) => key in node)
	);
}

function enforceStrictObjectShape(node: Record<string, unknown>): void {
	if (!describesObjectSchema(node)) return;
	if (node.type === undefined) node.type = "object";

	const properties = node.properties;
	const hasProperties =
		isSchemaRecord(properties) && Object.keys(properties).length > 0;
	const hasAnyOf = Array.isArray(node.anyOf) && node.anyOf.length > 0;
	if (!hasProperties && !hasAnyOf) {
		node.properties = {};
		if (Array.isArray(node.required) && node.required.length === 0) {
			delete node.required;
		}
	}
	node.additionalProperties = false;
}

export interface CerebrasSchemaNormalizationOptions {
	/**
	 * Strict tools require closed objects at every depth. Non-strict tools still
	 * need root compatibility and recursive cloning, but their open-map
	 * semantics must remain intact.
	 */
	strict?: boolean;
}

function walkSchemaChildren(
	node: Record<string, unknown>,
	options: CerebrasSchemaNormalizationOptions,
): void {
	for (const key of SCHEMA_MAP_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = Object.fromEntries(
			Object.entries(value).map(([name, schema]) => [
				name,
				normalizeSchemaForCerebras(schema, false, options),
			]),
		);
	}

	for (const key of SCHEMA_ARRAY_KEYS) {
		const value = node[key];
		if (!Array.isArray(value)) continue;
		node[key] = value.map((schema) =>
			normalizeSchemaForCerebras(schema, false, options),
		);
	}

	const items = node.items;
	if (Array.isArray(items)) {
		node.items = items.map((schema) =>
			normalizeSchemaForCerebras(schema, false, options),
		);
	} else if (items !== undefined) {
		node.items = normalizeSchemaForCerebras(items, false, options);
	}

	for (const key of SCHEMA_SINGLE_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = normalizeSchemaForCerebras(value, false, options);
	}

	const dependencies = node.dependencies;
	if (isSchemaRecord(dependencies)) {
		node.dependencies = Object.fromEntries(
			Object.entries(dependencies).map(([name, dependency]) => [
				name,
				Array.isArray(dependency)
					? [...dependency]
					: normalizeSchemaForCerebras(dependency, false, options),
			]),
		);
	}
}

export function normalizeSchemaForCerebras(
	schema: unknown,
	isRoot = false,
	options: CerebrasSchemaNormalizationOptions = {},
): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		// A missing/non-object tool schema means the tool takes no arguments.
		if (isRoot) {
			return options.strict === false
				? { type: "object" }
				: closedEmptyObjectSchema();
		}
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

	if (options.strict !== false) enforceStrictObjectShape(node);

	walkSchemaChildren(node, options);
	return node;
}
