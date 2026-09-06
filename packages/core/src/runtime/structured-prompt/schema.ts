/** Renders schema examples and validates structured model responses for dynamic prompts.
 * Schema diagnostics and metric keys share the same inferred value types. */
import type { SchemaRow, SchemaValueSpec } from "../../types/state";
import type { StructuredResponseFormat } from "./types";

export function flattenSchemaRows(rows: SchemaRow[]): SchemaRow[] {
	const flattened: SchemaRow[] = [];
	for (const row of rows) {
		flattened.push(row);
		if (row.properties?.length) {
			flattened.push(...flattenSchemaRows(row.properties));
		}
		if (row.items?.properties?.length) {
			flattened.push(...flattenSchemaRows(row.items.properties));
		}
	}
	return flattened;
}

export function renderJsonSchemaExample(rows: SchemaRow[]): string {
	const exampleObject = Object.fromEntries(
		rows.map((row) => [row.field, buildJsonExampleValue(row)]),
	);
	return `${JSON.stringify(exampleObject, null, 2)}\n`;
}

export function buildJsonExampleValue(spec: SchemaValueSpec): unknown {
	return buildJsonExampleValueAtDepth(spec, 0);
}

export function buildJsonExampleValueAtDepth(
	spec: SchemaValueSpec,
	depth: number,
): unknown {
	if (depth > 8) {
		return "[max schema depth reached]";
	}

	switch (getEffectiveSchemaValueType(spec)) {
		case "number":
			return 123;
		case "boolean":
			return true;
		case "object":
			if (spec.properties?.length) {
				return Object.fromEntries(
					spec.properties.map((row) => [
						row.field,
						buildJsonExampleValueAtDepth(row, depth + 1),
					]),
				);
			}
			return {};
		case "array":
			return [
				buildJsonExampleValueAtDepth(
					spec.items ?? { description: spec.description },
					depth + 1,
				),
			];
		default:
			return spec.description;
	}
}

export function validateResponseAgainstSchema(
	responseContent: Record<string, unknown>,
	schema: SchemaRow[],
): { missingPaths: string[]; invalidPaths: string[] } {
	const missingPaths: string[] = [];
	const invalidPaths: string[] = [];
	for (const row of schema) {
		validateSchemaValue(
			responseContent[row.field],
			row,
			row.field,
			missingPaths,
			invalidPaths,
		);
	}
	return { missingPaths, invalidPaths };
}

export function validateSchemaValue(
	value: unknown,
	spec: SchemaValueSpec,
	path: string,
	missingPaths: string[],
	invalidPaths: string[],
): void {
	validateSchemaValueAtDepth(value, spec, path, missingPaths, invalidPaths, 0);
}

export function validateSchemaValueAtDepth(
	value: unknown,
	spec: SchemaValueSpec,
	path: string,
	missingPaths: string[],
	invalidPaths: string[],
	depth: number,
): void {
	if (depth > 8) {
		invalidPaths.push(path);
		return;
	}

	const isMissingValue = (inner: unknown): boolean => {
		if (inner === undefined || inner === null) return true;
		if (typeof inner === "string") return inner.trim().length === 0;
		if (Array.isArray(inner)) return inner.length === 0;
		if (typeof inner === "object") return Object.keys(inner).length === 0;
		return false;
	};

	if (isMissingValue(value)) {
		if (spec.required) {
			missingPaths.push(path);
		}
		return;
	}

	switch (getEffectiveSchemaValueType(spec)) {
		case "number":
			if (
				typeof value !== "number" &&
				!(
					typeof value === "string" &&
					value.trim() !== "" &&
					!Number.isNaN(Number(value))
				)
			) {
				invalidPaths.push(path);
			}
			return;
		case "boolean":
			if (
				typeof value !== "boolean" &&
				!(
					typeof value === "string" &&
					["true", "false"].includes(value.trim().toLowerCase())
				)
			) {
				invalidPaths.push(path);
			}
			return;
		case "object":
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				invalidPaths.push(path);
				return;
			}
			for (const property of spec.properties ?? []) {
				validateSchemaValueAtDepth(
					(value as Record<string, unknown>)[property.field],
					property,
					`${path}.${property.field}`,
					missingPaths,
					invalidPaths,
					depth + 1,
				);
			}
			return;
		case "array":
			if (!Array.isArray(value)) {
				invalidPaths.push(path);
				return;
			}
			if (spec.items) {
				value.forEach((item, index) => {
					validateSchemaValueAtDepth(
						item,
						spec.items as SchemaValueSpec,
						`${path}[${index}]`,
						missingPaths,
						invalidPaths,
						depth + 1,
					);
				});
			}
			return;
		default:
			return;
	}
}

export function buildValidationOutputInstructions({
	format: _format,
	schema,
	perFieldCodes,
	includeFirstCheckpoint,
	includeLastCheckpoint,
}: {
	format: StructuredResponseFormat;
	schema: SchemaRow[];
	perFieldCodes: Map<string, string>;
	includeFirstCheckpoint: boolean;
	includeLastCheckpoint: boolean;
}): string {
	const lines: string[] = [];

	if (includeFirstCheckpoint) {
		lines.push(
			'Echo the prompt checkpoint fields: "one_initial_code", "one_middle_code", "one_end_code".',
		);
	}

	for (const row of schema) {
		const fieldCode = perFieldCodes.get(row.field);
		if (!fieldCode) {
			continue;
		}

		lines.push(
			`For "${row.field}", include "code_${row.field}_start": "${fieldCode}" and "code_${row.field}_end": "${fieldCode}".`,
		);
	}

	if (includeLastCheckpoint) {
		lines.push(
			'Echo the final checkpoint fields: "two_initial_code", "two_middle_code", "two_end_code".',
		);
	}

	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function getEffectiveSchemaValueType(
	spec: SchemaValueSpec,
): NonNullable<SchemaValueSpec["type"]> {
	if (spec.type) {
		return spec.type;
	}
	if (spec.items) {
		return "array";
	}
	if ((spec.properties?.length ?? 0) > 0) {
		return "object";
	}
	return "string";
}

export function collectSchemaDefinitionWarnings(rows: SchemaRow[]): string[] {
	const warnings: string[] = [];
	for (const row of rows) {
		collectSchemaSpecWarnings(row, row.field, warnings);
	}
	return warnings;
}

export function collectSchemaSpecWarnings(
	spec: SchemaValueSpec,
	path: string,
	warnings: string[],
	depth = 0,
): void {
	if (depth > 8) {
		warnings.push(`${path} exceeds max supported nesting depth`);
		return;
	}

	const hasProperties = (spec.properties?.length ?? 0) > 0;
	const hasItems = spec.items !== undefined;

	if (hasProperties && hasItems) {
		warnings.push(
			`${path} defines both properties and items; choose one shape`,
		);
	}

	if (spec.type === "array" && hasProperties) {
		warnings.push(`${path} is type "array" but also defines properties`);
	}

	if (spec.type === "object" && hasItems) {
		warnings.push(`${path} is type "object" but also defines items`);
	}

	if (
		(spec.type === "string" ||
			spec.type === "number" ||
			spec.type === "boolean") &&
		(hasProperties || hasItems)
	) {
		warnings.push(
			`${path} is type "${spec.type}" but also defines nested structure`,
		);
	}

	for (const property of spec.properties ?? []) {
		collectSchemaSpecWarnings(
			property,
			`${path}.${property.field}`,
			warnings,
			depth + 1,
		);
	}

	if (spec.items) {
		collectSchemaSpecWarnings(spec.items, `${path}[]`, warnings, depth + 1);
	}
}

export function buildSchemaMetricKey(rows: SchemaRow[]): string {
	return rows.map((row) => serializeSchemaMetricRow(row)).join("|");
}

export function serializeSchemaMetricRow(row: SchemaRow): string {
	return `${row.field}${row.required ? "!" : ""}:${serializeSchemaMetricSpec(row)}`;
}

export function serializeSchemaMetricSpec(spec: SchemaValueSpec): string {
	return serializeSchemaMetricSpecAtDepth(spec, 0);
}

export function serializeSchemaMetricSpecAtDepth(
	spec: SchemaValueSpec,
	depth: number,
): string {
	if (depth > 8) {
		return "max-depth";
	}

	const effectiveType = getEffectiveSchemaValueType(spec);
	switch (effectiveType) {
		case "object":
			return `object{${(spec.properties ?? [])
				.map(
					(property) =>
						`${property.field}${property.required ? "!" : ""}:${serializeSchemaMetricSpecAtDepth(property, depth + 1)}`,
				)
				.join(",")}}`;
		case "array":
			return `array[${spec.items ? serializeSchemaMetricSpecAtDepth(spec.items, depth + 1) : "unknown"}]`;
		default:
			return effectiveType;
	}
}
