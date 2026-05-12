import type { Action, ActionParameter, ActionParameterSchema } from "../types";
import type { JSONSchema } from "../types/model";

export type JsonSchemaPrimitiveType =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "object"
	| "array";

export interface JsonSchema {
	type?: JsonSchemaPrimitiveType;
	description?: string;
	enum?: Array<string | number | boolean>;
	default?: unknown;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	additionalProperties?: boolean | JsonSchema;
	minimum?: number;
	maximum?: number;
	pattern?: string;
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
}

export interface ActionParametersJsonSchema extends JsonSchema {
	type: "object";
	properties: Record<string, JsonSchema>;
	required: string[];
	additionalProperties?: boolean;
}

const SUPPORTED_SCHEMA_TYPES = new Set<string>([
	"string",
	"number",
	"integer",
	"boolean",
	"object",
	"array",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type LegacyActionParameterSchema = Omit<
	ActionParameterSchema,
	"enum" | "enumValues" | "required"
> & {
	enum?: unknown;
	enumValues?: unknown;
	options?: unknown;
	required?: boolean | string[];
	defaultValue?: unknown;
};

function readEnumValues(
	source: ActionParameter | ActionParameterSchema,
): Array<string | number | boolean> | undefined {
	const schema: LegacyActionParameterSchema =
		"schema" in source ? source.schema : source;
	const candidates = [
		schema.enumValues,
		schema.enum,
		schema.options,
		"options" in source ? source.options : undefined,
	];

	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) {
			continue;
		}

		const values = candidate
			.map((entry) => {
				if (
					typeof entry === "string" ||
					typeof entry === "number" ||
					typeof entry === "boolean"
				) {
					return entry;
				}
				if (isRecord(entry)) {
					const value = entry.value;
					if (
						typeof value === "string" ||
						typeof value === "number" ||
						typeof value === "boolean"
					) {
						return value;
					}
				}
				return undefined;
			})
			.filter(
				(entry): entry is string | number | boolean => entry !== undefined,
			);

		if (values.length > 0) {
			return values;
		}
	}

	return undefined;
}

function readRequiredPropertyNames(schema: ActionParameterSchema): Set<string> {
	const required = (schema as LegacyActionParameterSchema).required;
	if (!Array.isArray(required)) {
		return new Set();
	}
	return new Set(
		required.filter((entry): entry is string => typeof entry === "string"),
	);
}

function isSchemaRequired(schema: ActionParameterSchema): boolean {
	return (schema as LegacyActionParameterSchema).required === true;
}

function getSchemaDescription(
	schema: ActionParameterSchema,
	fallback?: string,
): string | undefined {
	return schema.description ?? fallback;
}

function getSchemaDefault(schema: ActionParameterSchema): unknown {
	if ("default" in schema) {
		return schema.default;
	}
	const legacy = schema as LegacyActionParameterSchema;
	if ("defaultValue" in legacy) {
		return legacy.defaultValue;
	}
	return undefined;
}

function assertSupportedSchemaType(
	type: string,
	path: string,
): asserts type is JsonSchemaPrimitiveType {
	if (!SUPPORTED_SCHEMA_TYPES.has(type)) {
		throw new Error(
			`Unsupported schema type '${type}' for action parameter '${path}'`,
		);
	}
}

export function actionParameterSchemaToJsonSchema(
	schema: ActionParameterSchema,
	options: { path?: string; description?: string; enumValues?: unknown[] } = {},
): JsonSchema {
	const path = options.path ?? "<anonymous>";
	const descriptionFromSchema = getSchemaDescription(
		schema,
		options.description,
	);

	if (schema.anyOf?.length) {
		return {
			...(descriptionFromSchema ? { description: descriptionFromSchema } : {}),
			anyOf: schema.anyOf.map((branch, index) =>
				actionParameterSchemaToJsonSchema(branch, {
					path: `${path}.anyOf[${index}]`,
				}),
			),
		};
	}

	if (schema.oneOf?.length) {
		return {
			...(descriptionFromSchema ? { description: descriptionFromSchema } : {}),
			oneOf: schema.oneOf.map((branch, index) =>
				actionParameterSchemaToJsonSchema(branch, {
					path: `${path}.oneOf[${index}]`,
				}),
			),
		};
	}

	const schemaType = schema.type;
	if (!schemaType) {
		throw new Error(
			`Action parameter schema at '${path}' must include a 'type' or use 'oneOf' / 'anyOf'`,
		);
	}
	assertSupportedSchemaType(schemaType, path);

	const jsonSchema: JsonSchema = { type: schemaType };
	const description = descriptionFromSchema;
	if (description) {
		jsonSchema.description = description;
	}

	const enumValues =
		options.enumValues?.filter(
			(entry): entry is string | number | boolean =>
				typeof entry === "string" ||
				typeof entry === "number" ||
				typeof entry === "boolean",
		) ?? readEnumValues(schema);
	if (enumValues && enumValues.length > 0) {
		jsonSchema.enum = enumValues;
	}

	const defaultValue = getSchemaDefault(schema);
	if (defaultValue !== undefined) {
		jsonSchema.default = defaultValue;
	}
	if (schema.minimum !== undefined) {
		jsonSchema.minimum = schema.minimum;
	}
	if (schema.maximum !== undefined) {
		jsonSchema.maximum = schema.maximum;
	}
	if (schema.pattern !== undefined) {
		jsonSchema.pattern = schema.pattern;
	}

	if (schema.type === "object") {
		const properties: Record<string, JsonSchema> = {};
		const requiredNames = readRequiredPropertyNames(schema);
		const required: string[] = [];

		for (const [name, childSchema] of Object.entries(schema.properties ?? {})) {
			properties[name] = actionParameterSchemaToJsonSchema(childSchema, {
				path: `${path}.${name}`,
			});
			if (requiredNames.has(name) || isSchemaRequired(childSchema)) {
				required.push(name);
			}
		}

		jsonSchema.properties = properties;
		jsonSchema.required = required;
		if (schema.additionalProperties !== undefined) {
			jsonSchema.additionalProperties =
				typeof schema.additionalProperties === "boolean"
					? schema.additionalProperties
					: actionParameterSchemaToJsonSchema(schema.additionalProperties, {
							path: `${path}.*`,
						});
		} else {
			jsonSchema.additionalProperties = false;
		}
	}

	if (schema.type === "array") {
		jsonSchema.items = schema.items
			? actionParameterSchemaToJsonSchema(schema.items, {
					path: `${path}[]`,
				})
			: { type: "string" };
	}

	return jsonSchema;
}

function preferCompressedParamDescription(
	parameter: ActionParameter,
): string | undefined {
	// Match `actionToTool`'s preference for the function-level description:
	// caveman-compressed form wins, then the alias, then the verbose form.
	// Surfacing the compressed text on parameters keeps the wire payload tight
	// and consistent with how action descriptions are rendered.
	return (
		parameter.descriptionCompressed ??
		parameter.compressedDescription ??
		parameter.description
	);
}

function appendParameterExamples(
	description: string | undefined,
	examples: ActionParameter["examples"],
): string | undefined {
	if (!Array.isArray(examples) || examples.length === 0) {
		return description;
	}
	const parts = examples
		.slice(0, 3)
		.map((example) =>
			typeof example === "string" ||
			typeof example === "number" ||
			typeof example === "boolean"
				? String(example)
				: JSON.stringify(example),
		)
		.filter((entry) => entry.length > 0);
	if (parts.length === 0) {
		return description;
	}
	const examplesPart = `e.g. ${parts.join(", ")}`;
	return description ? `${description} (${examplesPart})` : examplesPart;
}

export function actionParametersToJsonSchema(
	parameters: ActionParameter[] = [],
	options: { allowAdditionalProperties?: boolean } = {},
): ActionParametersJsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];

	for (const parameter of parameters) {
		const enumValues = readEnumValues(parameter);
		const baseDescription = preferCompressedParamDescription(parameter);
		const description = appendParameterExamples(
			baseDescription,
			parameter.examples,
		);
		properties[parameter.name] = actionParameterSchemaToJsonSchema(
			parameter.schema,
			{
				path: parameter.name,
				description,
				enumValues,
			},
		);
		if (parameter.required) {
			required.push(parameter.name);
		}
	}

	return {
		type: "object",
		properties,
		required,
		additionalProperties: options.allowAdditionalProperties === true,
	};
}

export function actionToJsonSchema(action: Action): ActionParametersJsonSchema {
	return actionParametersToJsonSchema(action.parameters ?? [], {
		allowAdditionalProperties: action.allowAdditionalParameters === true,
	});
}

// ---------------------------------------------------------------------------
// Normalization to the core `JSONSchema` shape
// ---------------------------------------------------------------------------
//
// `actionToJsonSchema` emits the LOCAL `JsonSchema` type (defined above). The
// runtime's grammar / structured-output plumbing speaks the core `JSONSchema`
// type from `types/model.ts` — a structurally-broader index-signature type
// whose `type` may be `string | string[]`. The two are *almost* assignable but
// TypeScript rejects the implicit conversion (the index signature, the wider
// `type`). `normalizeActionJsonSchema` walks the local schema and re-emits it
// as a core `JSONSchema` so an action's `parameters` schema can feed
// `compileSkeletonToGbnf` / `LlamaJsonSchemaGrammar` / the planner grammar
// without an unsafe cast. It is the single source of truth for "an action's
// parameter shape as a core JSON Schema".

function jsonSchemaFromLocal(local: JsonSchema): JSONSchema {
	const out: JSONSchema = {};
	if (local.type !== undefined) out.type = local.type;
	if (local.description !== undefined) out.description = local.description;
	if (local.enum !== undefined) out.enum = local.enum;
	if (local.default !== undefined)
		out.default = local.default as JSONSchema["default"];
	if (local.minimum !== undefined) out.minimum = local.minimum;
	if (local.maximum !== undefined) out.maximum = local.maximum;
	if (local.pattern !== undefined) out.pattern = local.pattern;
	if (local.required !== undefined) out.required = local.required;
	if (local.properties) {
		const properties: Record<string, JSONSchema> = {};
		for (const [name, child] of Object.entries(local.properties)) {
			properties[name] = jsonSchemaFromLocal(child);
		}
		out.properties = properties;
	}
	if (local.items) out.items = jsonSchemaFromLocal(local.items);
	if (local.additionalProperties !== undefined) {
		out.additionalProperties =
			typeof local.additionalProperties === "boolean"
				? local.additionalProperties
				: jsonSchemaFromLocal(local.additionalProperties);
	}
	if (local.oneOf) out.oneOf = local.oneOf.map(jsonSchemaFromLocal);
	if (local.anyOf) out.anyOf = local.anyOf.map(jsonSchemaFromLocal);
	return out;
}

/**
 * An action's `parameters` schema as a core {@link JSONSchema} (object schema
 * with `properties` / `required` / `additionalProperties`). Authoritative for
 * tool-calling, GBNF grammar generation, and post-hoc argument validation —
 * `Action` carries no `outputSchema`; `parameters` is the contract.
 */
export function normalizeActionJsonSchema(
	action: Pick<Action, "parameters" | "allowAdditionalParameters">,
): JSONSchema {
	return jsonSchemaFromLocal(
		actionParametersToJsonSchema(action.parameters ?? [], {
			allowAdditionalProperties: action.allowAdditionalParameters === true,
		}),
	);
}
