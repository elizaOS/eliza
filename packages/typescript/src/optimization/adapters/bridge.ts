/**
 * Bridge between Eliza types and Ax optimizer types.
 *
 * WHY a separate bridge: Eliza's SchemaRow[] and ExecutionTrace are the
 * internal representations; Ax expects signature strings and flat example
 * dicts. Isolating the translation here means neither Eliza core nor the
 * Ax adapters need to know about each other's type systems. If Ax is
 * replaced, only this file changes.
 */

import type { SchemaRow } from "../../types/state.ts";
import { ScoreCard } from "../score-card.ts";
import type { ExecutionTrace } from "../types.ts";

/**
 * Convert Eliza SchemaRow[] to a string-form Ax signature.
 * Ax accepts string signatures in format: "input1, input2 -> output1, output2"
 * with descriptions appended via the fluent builder.
 * Handles nested schemas by recursively flattening with dot-notation paths.
 */
export function schemaRowToAxSignatureString(schema: SchemaRow[]): string {
	const outputs = flattenSchemaFields(schema)
		.map(({ path, description }) => `${path}: ${description}`)
		.join(", ");
	return `contextText -> ${outputs}`;
}

export function flattenSchemaFields(
	rows: SchemaRow[],
	prefix = "",
): Array<{ path: string; description: string }> {
	const result: Array<{ path: string; description: string }> = [];
	for (const row of rows) {
		const path = prefix ? `${prefix}.${row.field}` : row.field;
		result.push({ path, description: row.description });
		if (row.properties?.length) {
			result.push(...flattenSchemaFields(row.properties, path));
		}
		if (row.items?.properties?.length) {
			result.push(...flattenSchemaFields(row.items.properties, `${path}[]`));
		}
	}
	return result;
}

/**
 * Convert an ExecutionTrace to an Ax-compatible training example.
 * The example maps from prompt inputs to structured response outputs.
 */
export function traceToAxExample(
	trace: ExecutionTrace,
): Record<string, unknown> {
	if (!trace.response) return {};
	return {
		contextText: trace.templateHash, // placeholder; real implementation uses actual prompt
		...trace.response,
	};
}

/**
 * Create an AxMetricFn-compatible function from ScoreCard data.
 * Returns a function that evaluates a prediction against an example
 * and returns a composite score.
 */
export function elizaMetricFn(
	_prediction: Record<string, unknown>,
	example: Record<string, unknown>,
): number {
	// When we have a scoreCard attached to the example (via trace lookup),
	// use it directly. Otherwise fall back to structural validity check.
	if (
		example._scoreCard &&
		typeof example._scoreCard === "object" &&
		"signals" in (example._scoreCard as object)
	) {
		return ScoreCard.fromJSON(
			example._scoreCard as {
				signals: Array<{
					source: string;
					kind: string;
					value: number;
					weight?: number;
				}>;
				compositeScore: number;
			},
		).composite();
	}

	// Basic structural validity: did the prediction have content?
	const hasContent =
		_prediction &&
		typeof _prediction === "object" &&
		Object.keys(_prediction).length > 0;
	return hasContent ? 0.5 : 0.0;
}

/**
 * Build training examples from a set of execution traces.
 * Filters to only successful traces with responses.
 */
export function buildTrainingExamples(
	traces: ExecutionTrace[],
): Array<Record<string, unknown>> {
	return traces
		.filter((t) => t.parseSuccess && t.response)
		.map((t) => ({
			...traceToAxExample(t),
			_scoreCard: t.scoreCard,
			_variant: t.variant,
			_traceId: t.id,
		}));
}
