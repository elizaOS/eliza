/**
 * Post-hoc validation of model-produced tool arguments against an Action's
 * parameter JSON Schema (from `actionToJsonSchema`). Checks type / enum / numeric
 * bounds / string pattern, enforces required fields and the additionalProperties
 * policy, and fills declared defaults, collecting human-readable error strings
 * rather than throwing. `validateSchema` is exported for verifying whole
 * structured outputs (e.g. remote-model planner JSON) too. Untrusted plugin
 * `pattern`s are compiled defensively and bounded by input length to blunt ReDoS,
 * since a JS regex runs synchronously and cannot be interrupted.
 */
import type { Action } from "../types";
import { isObjectRecord as isRecord } from "../utils/type-guards";
import { actionToJsonSchema, type JsonSchema } from "./action-schema";

export type { JsonSchema } from "./action-schema";

export interface ValidateToolArgsResult {
	valid: boolean;
	args: Record<string, unknown> | undefined;
	errors: string[];
}

/**
 * Cap on the input length a (plugin-supplied) schema `pattern` is tested
 * against. A malformed/malicious pattern with nested quantifiers can backtrack
 * catastrophically (ReDoS); since a JS regex runs synchronously and cannot be
 * interrupted by a timer, we bound the input length instead so the worst case
 * stays manageable.
 */
const MAX_PATTERN_INPUT_LENGTH = 50_000;

/**
 * Defensively compile + test an untrusted `pattern` (from a plugin parameter
 * schema) against `value`. The pattern may be an invalid regex (which would
 * otherwise throw an uncaught SyntaxError) or a ReDoS pattern. Returns ok:true
 * on match; ok:false with a reason when it doesn't match, the pattern is
 * invalid, or the value is too long to test safely.
 */
export function testSchemaPattern(
	pattern: string,
	value: string,
): { ok: true } | { ok: false; reason: string } {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch (err) {
		return {
			ok: false,
			reason: `has an invalid pattern ${pattern}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	if (value.length > MAX_PATTERN_INPUT_LENGTH) {
		return {
			ok: false,
			reason: `is too long to validate against pattern ${pattern}`,
		};
	}
	return regex.test(value)
		? { ok: true }
		: { ok: false, reason: `does not match pattern ${pattern}` };
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
			const childPath = path ? `${path}.${key}` : key;
			if (schema.additionalProperties === true) {
				output[key] = value[key];
				continue;
			}
			if (
				schema.additionalProperties &&
				typeof schema.additionalProperties === "object"
			) {
				const before = errors.length;
				const childValue = validateSchema(
					schema.additionalProperties,
					value[key],
					childPath,
					errors,
				);
				if (errors.length === before) {
					output[key] = childValue;
				}
				continue;
			}
			errors.push(`Unexpected argument '${childPath}'`);
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

/**
 * Walk a JSON Schema against `value`, appending human-readable error strings
 * to `errors`. Exposed for callers that need to verify whole structured
 * outputs (e.g. remote-model planner JSON before action dispatch), not just
 * per-action tool arguments — the same logic powers {@link validateToolArgs}.
 */
export function validateSchema(
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
				const result = testSchemaPattern(schema.pattern, value);
				if (!result.ok) {
					errors.push(
						`Argument '${formatPath(path)}' value '${value}' ${result.reason}`,
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
