/**
 * Provider compatibility for JSON-schema tool grammars and function names.
 *
 * Cerebras requires an object root and, in strict mode, closes every object
 * with `additionalProperties: false`. The normalizer walks every standard
 * schema-bearing keyword so hoisted definitions, conditionals, tuples, and map
 * schemas cannot bypass the wire contract while non-strict schemas retain
 * their permissive semantics.
 *
 * User-supplied tool schemas are JSON.parse-legal before this walk
 * (`plugin-openai` cerebrasMode). An 8k-deep `properties` nest or a cyclic
 * `not` graph RangeError'd the unbounded recursion on origin develop.
 * Depth, node, cycle, and accessor budgets fail closed instead.
 */
import { ElizaError } from "../errors";

const FUNCTION_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

export function sanitizeFunctionNameForCerebras(name: string): string {
	return name.replace(FUNCTION_NAME_PATTERN, "_");
}

/**
 * Honest tool schemas are a handful of objects deep. JSON.parse still
 * admits an 8k-deep `properties` nest that then RangeError'd
 * `normalizeSchemaForCerebras` on origin develop.
 */
export const MAX_CEREBRAS_SCHEMA_WALK_DEPTH = 64;
export const MAX_CEREBRAS_SCHEMA_WALK_NODES = 100_000;
export const CEREBRAS_SCHEMA_UNBOUNDED = "CEREBRAS_SCHEMA_UNBOUNDED";

type SchemaWalkContext = {
	visits: number;
	visiting: WeakSet<object>;
};

function failCerebrasSchemaUnbounded(
	context: Record<string, unknown>,
	cause?: unknown,
): never {
	throw new ElizaError("Cerebras tool schema exceeds the walk budget", {
		code: CEREBRAS_SCHEMA_UNBOUNDED,
		cause,
		context,
		severity: "fatal",
	});
}

export function isCerebrasSchemaUnbounded(error: unknown): boolean {
	return (
		error instanceof ElizaError && error.code === CEREBRAS_SCHEMA_UNBOUNDED
	);
}

function reserveSchemaVisits(ctx: SchemaWalkContext, count: number): void {
	if (count > MAX_CEREBRAS_SCHEMA_WALK_NODES - ctx.visits) {
		failCerebrasSchemaUnbounded({
			visits: ctx.visits + count,
			maxNodes: MAX_CEREBRAS_SCHEMA_WALK_NODES,
		});
	}
	ctx.visits += count;
}

function inspectSchema<T>(operation: string, inspect: () => T): T {
	try {
		return inspect();
	} catch (cause) {
		// error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
		failCerebrasSchemaUnbounded({ inspection: operation }, cause);
	}
}

function ownEnumerableStringKeys(value: object): string[] {
	const keys: string[] = [];
	for (const key of inspectSchema("ownKeys", () => Reflect.ownKeys(value))) {
		if (typeof key !== "string") continue;
		const descriptor = inspectSchema("getOwnPropertyDescriptor", () =>
			Object.getOwnPropertyDescriptor(value, key),
		);
		if (!descriptor?.enumerable) continue;
		keys.push(key);
	}
	return keys;
}

function ownValueDescriptor(
	value: object,
	key: string,
): PropertyDescriptor | undefined {
	const descriptor = inspectSchema("getOwnPropertyDescriptor", () =>
		Object.getOwnPropertyDescriptor(value, key),
	);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) {
		failCerebrasSchemaUnbounded({ accessor: true, key });
	}
	return descriptor;
}

function ownArrayLength(value: unknown[]): number {
	const descriptor = inspectSchema("getOwnPropertyDescriptor", () =>
		Object.getOwnPropertyDescriptor(value, "length"),
	);
	const length =
		descriptor && "value" in descriptor ? descriptor.value : value.length;
	if (typeof length !== "number" || !Number.isFinite(length) || length < 0) {
		failCerebrasSchemaUnbounded({ arrayLength: length });
	}
	return Math.trunc(length);
}

function isArrayRecord(value: unknown): value is unknown[] {
	return (
		Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
	);
}

function cloneOwnData(value: object): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ownEnumerableStringKeys(value)) {
		const descriptor = ownValueDescriptor(value, key);
		if (!descriptor) continue;
		Object.defineProperty(out, key, {
			value: descriptor.value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return out;
}

function createSchemaWalkContext(): SchemaWalkContext {
	return { visits: 0, visiting: new WeakSet<object>() };
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

function mapSchemaArray(
	value: unknown[],
	options: CerebrasSchemaNormalizationOptions,
	depth: number,
	ctx: SchemaWalkContext,
): unknown[] {
	const length = ownArrayLength(value);
	reserveSchemaVisits(ctx, length);
	const mapped: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = ownValueDescriptor(value, String(index));
		mapped.push(
			normalizeSchemaForCerebrasWalk(
				descriptor ? descriptor.value : undefined,
				false,
				options,
				depth + 1,
				ctx,
			),
		);
	}
	return mapped;
}

function mapSchemaRecord(
	value: object,
	options: CerebrasSchemaNormalizationOptions,
	depth: number,
	ctx: SchemaWalkContext,
): Record<string, unknown> {
	const keys = ownEnumerableStringKeys(value);
	reserveSchemaVisits(ctx, keys.length);
	const mapped: Record<string, unknown> = {};
	for (const name of keys) {
		const descriptor = ownValueDescriptor(value, name);
		Object.defineProperty(mapped, name, {
			value: normalizeSchemaForCerebrasWalk(
				descriptor ? descriptor.value : undefined,
				false,
				options,
				depth + 1,
				ctx,
			),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return mapped;
}

function walkSchemaChildren(
	node: Record<string, unknown>,
	options: CerebrasSchemaNormalizationOptions,
	depth: number,
	ctx: SchemaWalkContext,
): void {
	for (const key of SCHEMA_MAP_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = mapSchemaRecord(value, options, depth, ctx);
	}

	for (const key of SCHEMA_ARRAY_KEYS) {
		const value = node[key];
		if (!isArrayRecord(value)) continue;
		node[key] = mapSchemaArray(value, options, depth, ctx);
	}

	const items = node.items;
	if (isArrayRecord(items)) {
		node.items = mapSchemaArray(items, options, depth, ctx);
	} else if (items !== undefined) {
		node.items = normalizeSchemaForCerebrasWalk(
			items,
			false,
			options,
			depth + 1,
			ctx,
		);
	}

	for (const key of SCHEMA_SINGLE_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = normalizeSchemaForCerebrasWalk(
			value,
			false,
			options,
			depth + 1,
			ctx,
		);
	}

	const dependencies = node.dependencies;
	if (isSchemaRecord(dependencies)) {
		const keys = ownEnumerableStringKeys(dependencies);
		reserveSchemaVisits(ctx, keys.length);
		const mapped: Record<string, unknown> = {};
		for (const name of keys) {
			const descriptor = ownValueDescriptor(dependencies, name);
			const dependency = descriptor ? descriptor.value : undefined;
			Object.defineProperty(mapped, name, {
				value: isArrayRecord(dependency)
					? mapSchemaArray(dependency, options, depth, ctx)
					: normalizeSchemaForCerebrasWalk(
							dependency,
							false,
							options,
							depth + 1,
							ctx,
						),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		node.dependencies = mapped;
	}
}

function normalizeSchemaForCerebrasWalk(
	schema: unknown,
	isRoot: boolean,
	options: CerebrasSchemaNormalizationOptions,
	depth: number,
	ctx: SchemaWalkContext,
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

	if (depth > MAX_CEREBRAS_SCHEMA_WALK_DEPTH) {
		failCerebrasSchemaUnbounded({
			depth,
			max: MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
		});
	}
	if (ctx.visiting.has(schema)) {
		failCerebrasSchemaUnbounded({ cycle: true, depth });
	}
	ctx.visiting.add(schema);
	reserveSchemaVisits(ctx, 1);

	let node = cloneOwnData(schema);

	if (isRoot && hasIllegalCerebrasRoot(node)) {
		// Wrap the cloned schema under properties.value so the model still
		// emits a structured payload Cerebras's grammar compiler accepts.
		// Walking the clone (not the original) keeps cycle detection honest
		// when the illegal root is the same object the children point at.
		node = {
			type: "object",
			properties: { value: node },
			required: ["value"],
			additionalProperties: false,
		};
	}

	if (options.strict !== false) {
		enforceStrictObjectShape(node);
		// Cerebras's strict grammar compiler rejects `oneOf` outright
		// ("Unsupported JSON schema fields ... oneOf") while accepting `anyOf`
		// — verified against the live API with otherwise-identical payloads.
		// The weakening from exclusive-or to inclusive-or is immaterial here:
		// constrained generation emits a single value, and runtime validation
		// re-checks the parsed arguments. Non-strict schemas keep `oneOf`.
		if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
			const existing = Array.isArray(node.anyOf) ? node.anyOf : [];
			node.anyOf = [...existing, ...node.oneOf];
			delete node.oneOf;
		}
	}

	walkSchemaChildren(node, options, depth, ctx);
	return node;
}

export function normalizeSchemaForCerebras(
	schema: unknown,
	isRoot = false,
	options: CerebrasSchemaNormalizationOptions = {},
): unknown {
	return normalizeSchemaForCerebrasWalk(
		schema,
		isRoot,
		options,
		0,
		createSchemaWalkContext(),
	);
}
