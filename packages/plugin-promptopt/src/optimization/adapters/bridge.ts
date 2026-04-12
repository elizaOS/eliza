/**
 * Bridge between Eliza types and Ax optimizer types.
 *
 * **WHY a separate module:** `SchemaRow[]` and `ExecutionTrace` are Eliza’s
 * source of truth; Ax wants `AxGen` signatures and flat example objects. Keeping
 * translation here avoids leaking Ax types into `runtime.ts` and keeps a single
 * place to swap Ax for another backend (Phase B).
 *
 * **WHY `flattenSchemaFieldsForAxOutputs` (leaves only):** Nested DPE responses
 * store values under nested objects; parent `object` rows in the schema are not
 * keys in `trace.response`. Leaf paths align `buildAxTypedExamples` with
 * `resolveNestedValue` and with Ax output field names.
 */

import type { SchemaRow, SchemaValueType } from "@elizaos/core";
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
		if (row.properties?.length) {
			result.push(...flattenSchemaFields(row.properties, path));
			continue;
		}
		if (row.items?.properties?.length) {
			result.push(...flattenSchemaFields(row.items.properties, `${path}[]`));
			continue;
		}
		result.push({ path, description: row.description });
	}
	return result;
}

/**
 * Leaf output fields only (no parent object rows), aligned with nested
 * `trace.response` via {@link resolveNestedValue}.
 */
export function flattenSchemaFieldsForAxOutputs(
	rows: SchemaRow[],
	prefix = "",
): Array<{ path: string; description: string; valueType: SchemaValueType }> {
	const out: Array<{
		path: string;
		description: string;
		valueType: SchemaValueType;
	}> = [];
	for (const row of rows) {
		const path = prefix ? `${prefix}.${row.field}` : row.field;
		const valueType: SchemaValueType = row.type ?? "string";
		if (row.properties?.length) {
			out.push(...flattenSchemaFieldsForAxOutputs(row.properties, path));
			continue;
		}
		if (valueType === "array" && row.items?.properties?.length) {
			out.push(
				...flattenSchemaFieldsForAxOutputs(row.items.properties, `${path}[]`),
			);
			continue;
		}
		out.push({ path, description: row.description, valueType });
	}
	return out;
}

/**
 * Read a value from a nested trace.response using flatten-schema paths
 * (including `field[]` for array item fields).
 */
export function resolveNestedValue(
	obj: Record<string, unknown>,
	path: string,
): unknown {
	const parts = path.split(".");
	let current: unknown = obj;
	for (let i = 0; i < parts.length; i++) {
		if (current == null || typeof current !== "object") return undefined;
		const part = parts[i];
		const isArray = part.endsWith("[]");
		const cleanPart = isArray ? part.slice(0, -2) : part;
		current = (current as Record<string, unknown>)[cleanPart];
		if (isArray && Array.isArray(current) && i < parts.length - 1) {
			const rest = parts.slice(i + 1).join(".");
			return current
				.map((el) =>
					el != null && typeof el === "object"
						? resolveNestedValue(el as Record<string, unknown>, rest)
						: undefined,
				)
				.filter((v) => v !== undefined);
		}
	}
	return current;
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
		contextText: trace.templateHash,
		...trace.response,
	};
}

/**
 * AxMetricFn shape: ({ prediction, example }) => score.
 * Examples may carry `_scoreCard` from {@link buildAxTypedExamples}.
 * `signalWeights` matches {@link OptimizerPipelineConfig.signalWeights} so Ax
 * stages optimize the same objective as the pipeline baseline.
 */
export function elizaMetricFn(
	arg: Readonly<{
		prediction: unknown;
		example: Record<string, unknown>;
	}>,
	signalWeights?: Record<string, number>,
): number {
	const prediction =
		arg.prediction &&
		typeof arg.prediction === "object" &&
		!Array.isArray(arg.prediction)
			? (arg.prediction as Record<string, unknown>)
			: {};
	const { example } = arg;

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
		).composite(signalWeights);
	}

	const hasContent = Object.keys(prediction).length > 0;
	return hasContent ? 0.5 : 0.0;
}

/**
 * Returns a **one-argument** function suitable for `AxGEPA.compile` / `AxACE.compile`.
 *
 * **WHY a factory:** Ax’s `AxMetricFn` is always `(args) => number`; the pipeline’s
 * merged `signalWeights` must close over that single parameter — a second argument
 * is not part of Ax’s type.
 */
export function createElizaAxMetricFn(signalWeights: Record<string, number>) {
	return (arg: Parameters<typeof elizaMetricFn>[0]) =>
		elizaMetricFn(arg, signalWeights);
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

/**
 * Examples keyed by flattened schema paths (for AxGen I/O alignment).
 */
export function buildAxTypedExamples(
	traces: ExecutionTrace[],
	schema: SchemaRow[],
): Array<Record<string, unknown>> {
	const leaves = flattenSchemaFieldsForAxOutputs(schema);
	return traces
		.filter((t) => t.parseSuccess && t.response)
		.map((t) => {
			const ex: Record<string, unknown> = {
				contextText: t.templateHash,
				_scoreCard: t.scoreCard,
				_variant: t.variant,
				_traceId: t.id,
			};
			const resp = t.response as Record<string, unknown>;
			for (const { path } of leaves) {
				const v = resolveNestedValue(resp, path);
				if (v !== undefined) ex[path] = v;
			}
			return ex;
		});
}

type AxMod = typeof import("@ax-llm/ax");

function schemaValueToAxField(
	axMod: AxMod,
	valueType: SchemaValueType,
	description: string,
) {
	const { f } = axMod;
	switch (valueType) {
		case "number":
			return f.number(description);
		case "boolean":
			return f.boolean(description);
		case "object":
		case "array":
			return f.json(description);
		default:
			return f.string(description);
	}
}

/**
 * Build an AxGen program: `contextText` input and one output per schema leaf.
 */
export function buildAxProgram(
	axMod: AxMod,
	schema: SchemaRow[],
	promptTemplate: string,
): InstanceType<AxMod["AxGen"]> {
	const { f, AxGen } = axMod;
	const leaves = flattenSchemaFieldsForAxOutputs(schema);
	let sig = f().input(
		"contextText",
		f.string("Prompt / trace context (template hash)"),
	);
	if (leaves.length === 0) {
		sig = sig.output("response", f.json("Structured model response"));
	} else {
		for (const leaf of leaves) {
			sig = sig.output(
				leaf.path,
				schemaValueToAxField(axMod, leaf.valueType, leaf.description),
			);
		}
	}
	return new AxGen(sig.build(), { description: promptTemplate });
}

/** Best-effort instruction text from a GEPA Pareto result. */
export function extractGEPAInstructions(result: {
	paretoFront: ReadonlyArray<{
		configuration: Readonly<Record<string, unknown>>;
		scores: Readonly<Record<string, number>>;
	}>;
	bestScore: number;
	finalConfiguration?: Record<string, unknown>;
	optimizedProgram?: {
		instruction?: string;
		instructionMap?: Record<string, string>;
	};
}): string {
	const direct = result.optimizedProgram?.instruction?.trim();
	if (direct) return direct;

	const fromMap = result.optimizedProgram?.instructionMap;
	if (fromMap && Object.keys(fromMap).length > 0) {
		return Object.entries(fromMap)
			.map(([k, v]) => `### ${k}\n${v}`)
			.join("\n\n");
	}

	const cfg = result.finalConfiguration;
	if (cfg && typeof cfg === "object") {
		const text = configurationToInstructionText(cfg);
		if (text) return text;
	}

	const front = result.paretoFront;
	if (!front?.length) return "";

	let best = front[0];
	let bestScalar = Number.NEGATIVE_INFINITY;
	for (const p of front) {
		const keys = Object.keys(p.scores);
		const s =
			keys.length === 0
				? 0
				: keys.reduce((acc, k) => acc + (p.scores[k] ?? 0), 0) / keys.length;
		if (s > bestScalar) {
			bestScalar = s;
			best = p;
		}
	}
	return configurationToInstructionText(best.configuration) ?? "";
}

function configurationToInstructionText(
	cfg: Readonly<Record<string, unknown>>,
): string | undefined {
	const chunks: string[] = [];
	for (const [k, v] of Object.entries(cfg)) {
		if (typeof v === "string" && v.trim()) chunks.push(`### ${k}\n${v}`);
	}
	if (chunks.length) return chunks.join("\n\n");
	const primitiveOnly = Object.values(cfg).every(
		(v) =>
			v == null ||
			typeof v === "string" ||
			typeof v === "number" ||
			typeof v === "boolean",
	);
	if (primitiveOnly && Object.keys(cfg).length > 0) {
		return JSON.stringify(cfg, null, 2);
	}
	return undefined;
}

/** Serialize ACE playbook to markdown for {@link OptimizerAdapterResult.playbook}. */
export function extractACEPlaybook(playbook: {
	version: number;
	description?: string;
	sections: Record<string, Array<{ id: string; content: string }>>;
	stats: {
		bulletCount: number;
		helpfulCount: number;
		harmfulCount: number;
		tokenEstimate: number;
	};
	updatedAt: string;
}): string {
	const lines: string[] = [];
	if (playbook.description?.trim()) {
		lines.push(playbook.description.trim(), "");
	}
	for (const [section, bullets] of Object.entries(playbook.sections)) {
		lines.push(`## ${section}`);
		for (const b of bullets) {
			lines.push(`- (${b.id}) ${b.content}`);
		}
		lines.push("");
	}
	lines.push(
		`<!-- ace:version=${playbook.version} updatedAt=${playbook.updatedAt} bullets=${playbook.stats.bulletCount} -->`,
	);
	return lines.join("\n").trim();
}
