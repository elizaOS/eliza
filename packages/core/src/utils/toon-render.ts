import type {
	Action,
	ActionExample,
	ActionParameter,
	Provider,
	ProviderResult,
} from "../types/components";
import { compressPromptDescription } from "./prompt-compression";

/**
 * Plain JSON-shaped values accepted by JSON.stringify().
 */
type SerializableValue =
	| string
	| number
	| boolean
	| null
	| SerializableValue[]
	| { [key: string]: SerializableValue | undefined };

/**
 * Best-effort, deterministic compressed-description lookup. Mirrors the logic
 * of `renderCompressedDescription` in `actions.ts` so the compatibility renderer and
 * the prose renderer stay in sync.
 */
function pickCompressedDescription(item: {
	description?: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
}): string {
	if (
		typeof item.descriptionCompressed === "string" &&
		item.descriptionCompressed.trim()
	) {
		return item.descriptionCompressed.trim();
	}
	if (
		typeof item.compressedDescription === "string" &&
		item.compressedDescription.trim()
	) {
		return item.compressedDescription.trim();
	}
	if (typeof item.description === "string" && item.description.trim()) {
		return compressPromptDescription(item.description);
	}
	return "";
}

function uniqueNonEmpty(
	values: readonly (string | undefined | null)[],
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function formatParameterTypeLabel(parameter: ActionParameter): string {
	const schema = parameter.schema;
	switch (schema.type) {
		case "string":
			return "string";
		case "number":
			if (schema.minimum !== undefined || schema.maximum !== undefined) {
				return `number [${schema.minimum ?? "-inf"}-${schema.maximum ?? "inf"}]`;
			}
			return "number";
		case "boolean":
			return "boolean";
		case "array":
			return schema.items ? `array<${schema.items.type}>` : "array";
		case "object":
			return "object";
		default:
			return schema.type;
	}
}

function renderParameter(parameter: ActionParameter): {
	[key: string]: SerializableValue | undefined;
} {
	const description = pickCompressedDescription(parameter);
	const out: { [key: string]: SerializableValue | undefined } = {
		name: parameter.name,
		type: formatParameterTypeLabel(parameter),
		required: parameter.required ?? false,
	};
	if (description) {
		out.description = description;
	}
	if (parameter.schema.enum?.length) {
		out.enum = [...parameter.schema.enum];
	}
	if (parameter.schema.default !== undefined) {
		out.default = toSerializableValue(parameter.schema.default);
	}
	return out;
}

function getExampleHints(example: ActionExample[]): string[] {
	const hints = new Set<string>();
	for (const message of example) {
		const content = message.content as {
			action?: unknown;
			actions?: unknown;
		};
		if (typeof content.action === "string" && content.action.trim()) {
			hints.add(content.action.trim());
		}
		if (Array.isArray(content.actions)) {
			for (const candidate of content.actions) {
				if (typeof candidate === "string" && candidate.trim()) {
					hints.add(candidate.trim());
				}
			}
		}
	}
	return [...hints];
}

/**
 * Build the same kind of single-line example summary that
 * `formatActionExampleSummary` in `actions.ts` produces. We keep behavior
 * deliberately equivalent so callers can swap renderers without changing
 * prompt contents.
 */
function buildExampleSummary(action: Action): string | null {
	const examples = action.examples ?? [];
	if (!Array.isArray(examples) || examples.length === 0) {
		return null;
	}

	for (const example of examples) {
		if (!Array.isArray(example) || example.length === 0) {
			continue;
		}
		const userMessage = example[0]?.content?.text?.trim();
		if (!userMessage) {
			continue;
		}
		const hints = getExampleHints(example);
		const hintList = hints.length > 0 ? hints.join(", ") : action.name;
		return `User: ${userMessage} -> actions: ${hintList}`;
	}

	return null;
}

/**
 * Serialize an `Action` to human-readable JSON. The exported name is retained
 * for older callers that imported the TOON-specific helper.
 *
 * Output mirrors what `formatActions` would
 * include for a single action: name, similes/aliases, parameters, ONE example
 * summary, and the compressed description (via `renderCompressedDescription`).
 */
export function toonRenderAction(action: Action): string {
	const description = pickCompressedDescription(action);
	const aliases = uniqueNonEmpty(action.similes ?? []);
	const tags = uniqueNonEmpty(action.tags ?? []).filter(
		(tag) => tag !== "always-include",
	);
	const parameters = (action.parameters ?? []).map(renderParameter);
	const example = buildExampleSummary(action);

	const payload: { [key: string]: SerializableValue | undefined } = {
		name: action.name,
	};

	if (description) {
		payload.description = description;
	}
	if (aliases.length > 0) {
		payload.aliases = aliases;
	}
	if (tags.length > 0) {
		payload.tags = tags;
	}
	if (parameters.length > 0) {
		payload.parameters = parameters;
	}
	if (example) {
		payload.example = example;
	}

	const cleaned: { [key: string]: SerializableValue } = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		cleaned[key] = value;
	}

	return JSON.stringify(cleaned, null, 2);
}

function isPrimitive(
	value: unknown,
): value is string | number | boolean | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function toSerializableValue(value: unknown): SerializableValue {
	if (isPrimitive(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => toSerializableValue(entry));
	}
	if (typeof value === "object" && value !== null) {
		const out: { [key: string]: SerializableValue } = {};
		for (const [k, v] of Object.entries(value)) {
			if (v === undefined) continue;
			out[k] = toSerializableValue(v);
		}
		return out;
	}
	// `bigint`, `function`, `symbol`, `undefined` collapse to a string view so
	// JSON serialization stays deterministic.
	return String(value);
}

/**
 * Serialize a provider's static metadata + dynamic result to JSON. Plugin
 * authors use this when they want to emit provider state in the same shape
 * the planner already understands. The exported name is retained for older
 * callers that imported the TOON-specific helper.
 *
 * `result` is optional because providers can be rendered before they have run
 * (for catalog/diagnostic UIs).
 */
export function toonRenderProvider(
	provider: Provider,
	result?: ProviderResult,
): string {
	const description = pickCompressedDescription(provider);
	const tags = uniqueNonEmpty(
		// Providers don't have a tags field today, but we accept any sibling
		// `tags` array a caller has glued on without breaking the renderer.
		(provider as Provider & { tags?: string[] }).tags ?? [],
	);

	const payload: { [key: string]: SerializableValue | undefined } = {
		name: provider.name,
	};

	if (description) {
		payload.description = description;
	}
	if (provider.dynamic) {
		payload.dynamic = true;
	}
	if (typeof provider.position === "number") {
		payload.position = provider.position;
	}
	if (provider.private) {
		payload.private = true;
	}
	if (tags.length > 0) {
		payload.tags = tags;
	}
	if (result) {
		if (typeof result.text === "string" && result.text.trim()) {
			payload.text = result.text.trim();
		}
		if (result.values && Object.keys(result.values).length > 0) {
			payload.values = toSerializableValue(result.values);
		}
		if (result.data && Object.keys(result.data).length > 0) {
			payload.data = toSerializableValue(result.data);
		}
	}

	const cleaned: { [key: string]: SerializableValue } = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		cleaned[key] = value;
	}

	return JSON.stringify(cleaned, null, 2);
}
