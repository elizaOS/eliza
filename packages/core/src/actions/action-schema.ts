import type { Action, ActionParameter, ActionParameterSchema } from "../types";

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
	additionalProperties?: false;
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

function readSchemaRecord(
	schema: ActionParameterSchema,
): Record<string, unknown> {
	return schema as unknown as Record<string, unknown>;
}

function readEnumValues(
	source: ActionParameter | ActionParameterSchema,
): Array<string | number | boolean> | undefined {
	const record = source as unknown as Record<string, unknown>;
	const schema =
		"schema" in record && isRecord(record.schema)
			? (record.schema as Record<string, unknown>)
			: record;
	const candidates = [
		schema.enumValues,
		schema.enum,
		schema.options,
		record.options,
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
	const required = readSchemaRecord(schema).required;
	if (!Array.isArray(required)) {
		return new Set();
	}
	return new Set(
		required.filter((entry): entry is string => typeof entry === "string"),
	);
}

function isSchemaRequired(schema: ActionParameterSchema): boolean {
	return readSchemaRecord(schema).required === true;
}

function getSchemaDescription(
	schema: ActionParameterSchema,
	fallback?: string,
): string | undefined {
	return schema.description ?? fallback;
}

function getSchemaDefault(schema: ActionParameterSchema): unknown {
	const record = readSchemaRecord(schema);
	if ("default" in record) {
		return record.default;
	}
	if ("defaultValue" in record) {
		return record.defaultValue;
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
		jsonSchema.additionalProperties = false;
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
		additionalProperties: false,
	};
}

export function actionToJsonSchema(action: Action): ActionParametersJsonSchema {
	return actionParametersToJsonSchema(action.parameters ?? []);
}
