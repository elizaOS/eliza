import type { Action } from "../types";
import { actionToJsonSchema, type JsonSchema } from "./action-schema";

export interface ValidateToolArgsResult {
	valid: boolean;
	args: Record<string, unknown> | undefined;
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

function formatPath(path: string): string {
	return path || "<args>";
}

function validateEnum(
	schema: JsonSchema,
	value: unknown,
	path: string,
	errors: string[],
): void {
	if (
		!schema.enum ||
		schema.enum.includes(value as string | number | boolean)
	) {
		return;
	}

	errors.push(
		`Argument '${formatPath(path)}' value '${String(value)}' is not one of: ${schema.enum.join(", ")}`,
	);
}

function validateNumberBounds(
	schema: JsonSchema,
	value: number,
	path: string,
	errors: string[],
): void {
	if (schema.minimum !== undefined && value < schema.minimum) {
		errors.push(
			`Argument '${formatPath(path)}' value ${value} is below minimum ${schema.minimum}`,
		);
	}
	if (schema.maximum !== undefined && value > schema.maximum) {
		errors.push(
			`Argument '${formatPath(path)}' value ${value} is above maximum ${schema.maximum}`,
		);
	}
}

function validateObject(
	schema: JsonSchema,
	value: Record<string, unknown>,
	path: string,
	errors: string[],
): Record<string, unknown> {
	const properties = schema.properties ?? {};
	const output: Record<string, unknown> = {};

	for (const key of schema.required ?? []) {
		if (
			!hasOwn(value, key) ||
			value[key] === undefined ||
			value[key] === null
		) {
			errors.push(
				`Missing required argument '${path ? `${path}.${key}` : key}'`,
			);
		}
	}

	for (const key of Object.keys(value)) {
		if (!hasOwn(properties, key)) {
			errors.push(`Unexpected argument '${path ? `${path}.${key}` : key}'`);
		}
	}

	for (const [key, childSchema] of Object.entries(properties)) {
		if (hasOwn(value, key) && value[key] !== undefined && value[key] !== null) {
			const childPath = path ? `${path}.${key}` : key;
			const before = errors.length;
			const childValue = validateSchema(
				childSchema,
				value[key],
				childPath,
				errors,
			);
			if (errors.length === before) {
				output[key] = childValue;
			}
			continue;
		}

		if (
			childSchema.default !== undefined &&
			!(schema.required ?? []).includes(key)
		) {
			output[key] = childSchema.default;
		}
	}

	return output;
}

function validateSchema(
	schema: JsonSchema,
	value: unknown,
	path: string,
	errors: string[],
): unknown {
	if (schema.anyOf && schema.anyOf.length > 0) {
		let matched: unknown = value;
		let ok = false;
		for (const branch of schema.anyOf) {
			const branchErrors: string[] = [];
			const result = validateSchema(branch, value, path, branchErrors);
			if (branchErrors.length === 0) {
				ok = true;
				matched = result;
				break;
			}
		}
		if (!ok) {
			errors.push(
				`Argument '${formatPath(path)}' did not satisfy any anyOf branch`,
			);
		}
		return matched;
	}

	if (schema.oneOf && schema.oneOf.length > 0) {
		let matches = 0;
		let matched: unknown = value;
		for (const branch of schema.oneOf) {
			const branchErrors: string[] = [];
			const result = validateSchema(branch, value, path, branchErrors);
			if (branchErrors.length === 0) {
				matches++;
				matched = result;
			}
		}
		if (matches === 0) {
			errors.push(
				`Argument '${formatPath(path)}' did not satisfy any oneOf branch`,
			);
		} else if (matches > 1) {
			errors.push(
				`Argument '${formatPath(path)}' satisfied multiple oneOf branches (${matches})`,
			);
		}
		return matched;
	}

	switch (schema.type) {
		case "string":
			if (typeof value !== "string") {
				errors.push(
					`Argument '${formatPath(path)}' expected string, got ${describeType(value)}`,
				);
				return value;
			}
			validateEnum(schema, value, path, errors);
			if (schema.pattern !== undefined) {
				const regex = new RegExp(schema.pattern);
				if (!regex.test(value)) {
					errors.push(
						`Argument '${formatPath(path)}' value '${value}' does not match pattern ${schema.pattern}`,
					);
				}
			}
			return value;

		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) {
				errors.push(
					`Argument '${formatPath(path)}' expected number, got ${describeType(value)}`,
				);
				return value;
			}
			validateEnum(schema, value, path, errors);
			validateNumberBounds(schema, value, path, errors);
			return value;

		case "integer":
			if (
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				!Number.isInteger(value)
			) {
				errors.push(
					`Argument '${formatPath(path)}' expected integer, got ${describeType(value)}`,
				);
				return value;
			}
			validateEnum(schema, value, path, errors);
			validateNumberBounds(schema, value, path, errors);
			return value;

		case "boolean":
			if (typeof value !== "boolean") {
				errors.push(
					`Argument '${formatPath(path)}' expected boolean, got ${describeType(value)}`,
				);
				return value;
			}
			validateEnum(schema, value, path, errors);
			return value;

		case "array":
			if (!Array.isArray(value)) {
				errors.push(
					`Argument '${formatPath(path)}' expected array, got ${describeType(value)}`,
				);
				return value;
			}
			return value.map((entry, index) =>
				validateSchema(
					schema.items ?? { type: "string" },
					entry,
					`${path}[${index}]`,
					errors,
				),
			);

		case "object":
			if (!isRecord(value)) {
				errors.push(
					`Argument '${formatPath(path)}' expected object, got ${describeType(value)}`,
				);
				return value;
			}
			return validateObject(schema, value, path, errors);
		default:
			errors.push(
				`Argument '${formatPath(path)}' has unsupported or missing JSON schema type`,
			);
			return value;
	}
}

export function validateToolArgs(
	action: Action,
	args: unknown,
): ValidateToolArgsResult {
	const schema = actionToJsonSchema(action);
	const errors: string[] = [];

	if (!isRecord(args)) {
		return {
			valid: false,
			args: undefined,
			errors: [`Tool arguments for action ${action.name} must be an object`],
		};
	}

	const validatedArgs = validateObject(schema, args, "", errors);

	return {
		valid: errors.length === 0,
		args: errors.length === 0 ? validatedArgs : undefined,
		errors,
	};
}
