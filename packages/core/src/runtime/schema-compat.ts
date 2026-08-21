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
 * Depth, node, path-local cycle, and accessor budgets fail closed instead.
 * Array.isArray / getPrototypeOf / length reads stay inside inspectSchema
 * so a revoked or hostile Array Proxy cannot leak a raw TypeError.
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
	/** Path-local ancestry only. Entries are deleted on unwind so honest DAGs pass. */
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
		if (isCerebrasSchemaUnbounded(cause)) {
			throw cause;
		}
		// error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
		failCerebrasSchemaUnbounded({ inspection: operation }, cause);
	}
}

function safeIsArray(value: unknown): boolean {
	return inspectSchema("isArray", () => Array.isArray(value));
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
	if (!descriptor || !("value" in descriptor)) {
		failCerebrasSchemaUnbounded({
			arrayLength: true,
			missingOwnLength: true,
		});
	}
	const length = descriptor.value;
	if (typeof length !== "number" || !Number.isFinite(length) || length < 0) {
		failCerebrasSchemaUnbounded({ arrayLength: length });
	}
	return Math.trunc(length);
}

function ownArrayValues(value: unknown[]): unknown[] {
	const length = ownArrayLength(value);
	const mapped: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = ownValueDescriptor(value, String(index));
		mapped.push(descriptor ? descriptor.value : undefined);
	}
	return mapped;
}

function isArrayRecord(value: unknown): value is unknown[] {
	return inspectSchema("isArrayRecord", () => {
		return (
			Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
		);
	});
}

function hasNonEmptyOwnArray(value: unknown): boolean {
	return isArrayRecord(value) && ownArrayLength(value) > 0;
}

type OwnDataEntry = { key: string; value: unknown };

/**
 * Single-pass immutable snapshot of the own enumerable string-keyed DATA
 * properties. Every descriptor trap runs exactly once and the captured value
 * is the one every later step consumes, so a Proxy cannot present a benign
 * data descriptor during filtering and a different value (or an accessor) on a
 * second read. The raw own-key width is reserved BEFORE anything is captured,
 * so a node with >100k irrelevant keys trips MAX_CEREBRAS_SCHEMA_WALK_NODES
 * instead of allocating first.
 */
function ownDataEntries(value: object, ctx: SchemaWalkContext): OwnDataEntry[] {
	const keys = inspectSchema("ownKeys", () => Reflect.ownKeys(value));
	reserveSchemaVisits(ctx, keys.length);
	const entries: OwnDataEntry[] = [];
	for (const key of keys) {
		if (typeof key !== "string") continue;
		const descriptor = inspectSchema("getOwnPropertyDescriptor", () =>
			Object.getOwnPropertyDescriptor(value, key),
		);
		if (!descriptor?.enumerable) continue;
		if (!("value" in descriptor)) {
			failCerebrasSchemaUnbounded({ accessor: true, key });
		}
		entries.push({ key, value: descriptor.value });
	}
	return entries;
}

function defineOwnData(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function cloneOwnData(
	value: object,
	ctx: SchemaWalkContext,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const entry of ownDataEntries(value, ctx)) {
		defineOwnData(out, entry.key, entry.value);
	}
	return out;
}

function createSchemaWalkContext(): SchemaWalkContext {
	return { visits: 0, visiting: new WeakSet<object>() };
}

function cloneSchemaTransportMap(
	value: object,
	depth: number,
	ctx: SchemaWalkContext,
): Record<string, unknown> {
	const mapped: Record<string, unknown> = {};
	for (const entry of ownDataEntries(value, ctx)) {
		defineOwnData(
			mapped,
			entry.key,
			cloneSchemaTransportWalk(entry.value, depth + 1, ctx),
		);
	}
	return mapped;
}

function cloneSchemaTransportArray(
	value: unknown[],
	depth: number,
	ctx: SchemaWalkContext,
): unknown[] {
	// Reserve the validated own length BEFORE allocating or scanning, so a huge
	// sparse array trips the aggregate budget instead of driving descriptor
	// calls and allocation first.
	const length = ownArrayLength(value);
	reserveSchemaVisits(ctx, length);
	const mapped = new Array(length);
	for (let index = 0; index < length; index += 1) {
		const key = String(index);
		const descriptor = ownValueDescriptor(value, key);
		// A missing own index is a hole. Leave it a hole: tuple keywords
		// (`prefixItems`, tuple `items`) distinguish an absent element from an
		// explicit `undefined`, and the origin `value.map(...)` preserved holes.
		if (!descriptor) continue;
		defineOwnData(
			mapped as unknown as Record<string, unknown>,
			key,
			cloneSchemaTransportWalk(descriptor.value, depth + 1, ctx),
		);
	}
	return mapped;
}

/**
 * Clone the schema-bearing children of an already-snapshotted node, using the
 * SAME keyword tables, the same guards, and the same depth accounting as
 * `walkSchemaChildren`. Keys that are not schema-bearing (`default`,
 * `examples`, `const`, `enum`, `required`, `x-*` extensions, ...) hold
 * arbitrary JSON data, not sub-schemas: the normalizer and `sanitizeJsonSchema`
 * both leave them alone, so the pre-pass leaves them alone too. Their values
 * are already captured in the immutable descriptor snapshot, so they are
 * carried across without executing a single accessor.
 */
function cloneSchemaTransportChildren(
	node: Record<string, unknown>,
	depth: number,
	ctx: SchemaWalkContext,
): void {
	for (const key of SCHEMA_MAP_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = cloneSchemaTransportMap(value, depth, ctx);
	}

	for (const key of SCHEMA_ARRAY_KEYS) {
		const value = node[key];
		if (!isArrayRecord(value)) continue;
		node[key] = cloneSchemaTransportArray(value, depth, ctx);
	}

	const items = node.items;
	if (isArrayRecord(items)) {
		node.items = cloneSchemaTransportArray(items, depth, ctx);
	} else if (items !== undefined) {
		node.items = cloneSchemaTransportWalk(items, depth + 1, ctx);
	}

	for (const key of SCHEMA_SINGLE_KEYS) {
		const value = node[key];
		if (!isSchemaRecord(value)) continue;
		node[key] = cloneSchemaTransportWalk(value, depth + 1, ctx);
	}

	const dependencies = node.dependencies;
	if (isSchemaRecord(dependencies)) {
		const mapped: Record<string, unknown> = {};
		for (const entry of ownDataEntries(dependencies, ctx)) {
			defineOwnData(
				mapped,
				entry.key,
				isArrayRecord(entry.value)
					? cloneSchemaTransportArray(entry.value, depth, ctx)
					: cloneSchemaTransportWalk(entry.value, depth + 1, ctx),
			);
		}
		node.dependencies = mapped;
	}
}

function cloneSchemaTransportWalk(
	schema: unknown,
	depth: number,
	ctx: SchemaWalkContext,
): unknown {
	// Mirrors normalizeSchemaForCerebrasWalk: a non-object (or an array reached
	// outside an array-valued keyword) is data, not a schema node, and passes
	// through untouched.
	if (!schema || typeof schema !== "object" || safeIsArray(schema)) {
		return schema;
	}

	if (depth > MAX_CEREBRAS_SCHEMA_WALK_DEPTH) {
		failCerebrasSchemaUnbounded({
			depth,
			max: MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
			clone: true,
		});
	}
	if (ctx.visiting.has(schema)) {
		failCerebrasSchemaUnbounded({ cycle: true, depth, clone: true });
	}
	ctx.visiting.add(schema);
	reserveSchemaVisits(ctx, 1);

	try {
		const node = cloneOwnData(schema, ctx);
		cloneSchemaTransportChildren(node, depth, ctx);
		return node;
	} finally {
		ctx.visiting.delete(schema);
	}
}

/**
 * Bounded, descriptor-only clone of a tool schema that applies NO Cerebras
 * semantics.
 *
 * The strict Cerebras tool path is
 * `normalizeNativeToolsForCall -> sanitizeJsonSchema -> normalizeSchemaForCerebras`,
 * and `sanitizeJsonSchema` uses ordinary spread / `Object.entries` / `.map` /
 * unbounded recursion, so it must never see a hostile or unbounded graph. But
 * running the full Cerebras normalizer first is also wrong: it closes every
 * declared open map (`additionalProperties: true` or a schema value) with
 * `additionalProperties: false`, which is exactly the signal
 * `sanitizeJsonSchema` needs to build the `__eliza_record_entries` reverse
 * transform (#11249).
 *
 * This clone is the safe pre-pass. It walks EXACTLY the schema-bearing
 * keywords `normalizeSchemaForCerebras` walks (a superset of the ones
 * `sanitizeJsonSchema` recurses into), with the same depth accounting, the
 * same aggregate node budget, the same path-local cycle detection, and the
 * same descriptor-only reflection — but it copies declared shape verbatim
 * (holes included) and never descends into annotation/extension data such as
 * `default`, `examples`, `const`, or `x-*`, which are legal arbitrary JSON and
 * which the normalizer and the sanitizer both leave untouched. Accepting
 * exactly what the normalizer accepts is the compatibility contract; the
 * budgets exist to stop unbounded SCHEMA recursion, not to cap user data.
 *
 * Sanitization then runs on a plain, budgeted graph with declared semantics
 * intact, and `normalizeSchemaForCerebras` applies provider semantics
 * afterwards.
 */
export function cloneSchemaForBoundedTransport(schema: unknown): unknown {
	return cloneSchemaTransportWalk(schema, 0, createSchemaWalkContext());
}

function hasIllegalCerebrasRoot(node: Record<string, unknown>): boolean {
	if (node.type !== "object") return true;
	if (hasNonEmptyOwnArray(node.oneOf)) return true;
	if (hasNonEmptyOwnArray(node.anyOf)) return true;
	if (isArrayRecord(node.enum)) return true;
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

export const JSON_SCHEMA_ARRAY_KEYWORDS = [
	"anyOf",
	"oneOf",
	"allOf",
	"prefixItems",
] as const;
export const JSON_SCHEMA_SINGLE_KEYWORDS = [
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
export const JSON_SCHEMA_MAP_KEYWORDS = [
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
] as const;
export const JSON_SCHEMA_MIXED_MAP_KEYWORDS = ["dependencies"] as const;

const SCHEMA_ARRAY_KEYS = JSON_SCHEMA_ARRAY_KEYWORDS;
const SCHEMA_SINGLE_KEYS = JSON_SCHEMA_SINGLE_KEYWORDS;
const SCHEMA_MAP_KEYS = JSON_SCHEMA_MAP_KEYWORDS;

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !safeIsArray(value);
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
		(safeIsArray(type) &&
			ownArrayValues(type as unknown[]).includes("object")) ||
		OBJECT_SCHEMA_KEYS.some((key) => key in node)
	);
}

function enforceStrictObjectShape(node: Record<string, unknown>): void {
	if (!describesObjectSchema(node)) return;
	if (node.type === undefined) node.type = "object";

	const properties = node.properties;
	const hasProperties =
		isSchemaRecord(properties) &&
		ownEnumerableStringKeys(properties).length > 0;
	const hasAnyOf = hasNonEmptyOwnArray(node.anyOf);
	if (!hasProperties && !hasAnyOf) {
		node.properties = {};
		if (isArrayRecord(node.required) && ownArrayLength(node.required) === 0) {
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
	const mapped: unknown[] = new Array(length);
	for (let index = 0; index < length; index += 1) {
		const descriptor = ownValueDescriptor(value, String(index));
		if (!descriptor) continue;
		mapped[index] = normalizeSchemaForCerebrasWalk(
			descriptor.value,
			false,
			options,
			depth + 1,
			ctx,
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
	// One descriptor pass, one immutable snapshot: a Proxy must not be able to
	// present a data descriptor during filtering and something else on a
	// second read.
	const mapped: Record<string, unknown> = {};
	for (const entry of ownDataEntries(value, ctx)) {
		defineOwnData(
			mapped,
			entry.key,
			normalizeSchemaForCerebrasWalk(
				entry.value,
				false,
				options,
				depth + 1,
				ctx,
			),
		);
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
		const mapped: Record<string, unknown> = {};
		for (const entry of ownDataEntries(dependencies, ctx)) {
			defineOwnData(
				mapped,
				entry.key,
				isArrayRecord(entry.value)
					? mapSchemaArray(entry.value, options, depth, ctx)
					: normalizeSchemaForCerebrasWalk(
							entry.value,
							false,
							options,
							depth + 1,
							ctx,
						),
			);
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
	if (!schema || typeof schema !== "object" || safeIsArray(schema)) {
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

	try {
		let node = cloneOwnData(schema, ctx);

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
			if (hasNonEmptyOwnArray(node.oneOf)) {
				const existing = isArrayRecord(node.anyOf)
					? ownArrayValues(node.anyOf)
					: [];
				node.anyOf = [...existing, ...ownArrayValues(node.oneOf as unknown[])];
				delete node.oneOf;
			}
		}

		walkSchemaChildren(node, options, depth, ctx);
		return node;
	} finally {
		ctx.visiting.delete(schema);
	}
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
