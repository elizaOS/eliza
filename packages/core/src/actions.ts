import { allActionDocs } from "./generated/action-docs.ts";
import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionParameterSchema,
	ActionParameters,
	ActionParameterValue,
	JsonValue,
} from "./types";
import {
	buildDeterministicSeed,
	createDeterministicRandom,
	deterministicShuffle,
	getDeterministicNames,
} from "./utils/deterministic";
import { compressPromptDescription } from "./utils/prompt-compression";

export {
	CANONICAL_SUBACTION_KEY,
	DEFAULT_SUBACTION_KEYS,
	dispatchSubaction,
	normalizeSubaction,
	readSubaction,
	type SubactionHandler,
	type SubactionHandlerMap,
	type SubactionParameters,
} from "./actions/subaction-dispatch";

export {
	isPromotedSubactionVirtual,
	listSubactionsFromParameters,
	promoteSubactionsToActions,
	type PromoteSubactionsOptions,
	type SubactionPromotionOverrides,
} from "./actions/promote-subactions";

type ActionDocByName = Record<string, (typeof allActionDocs)[number]>;

const actionDocByName: ActionDocByName = allActionDocs.reduce<ActionDocByName>(
	(acc, doc) => {
		acc[doc.name] = doc;
		return acc;
	},
	{},
);

export const composeActionExamples = (
	actionsData: Action[],
	count: number,
	seed = "actions",
): string => {
	if (!actionsData.length || count <= 0) {
		return "";
	}

	const actionsWithExamples = actionsData.filter(
		(action) =>
			action.examples &&
			Array.isArray(action.examples) &&
			action.examples.length > 0,
	);

	if (!actionsWithExamples.length) {
		return "";
	}

	const examplesCopy: ActionExample[][][] = actionsWithExamples.map(
		(action) => [...(action.examples || [])],
	);

	const selectedExamples: ActionExample[][] = [];
	const random = createDeterministicRandom(
		buildDeterministicSeed(seed, "examples"),
	);

	const availableActionIndices = examplesCopy
		.map((examples, index) => (examples.length > 0 ? index : -1))
		.filter((index) => index !== -1);

	while (selectedExamples.length < count && availableActionIndices.length > 0) {
		const randomIndex = Math.floor(random() * availableActionIndices.length);
		const actionIndex = availableActionIndices[randomIndex];
		const examples = examplesCopy[actionIndex];

		const exampleIndex = Math.floor(random() * examples.length);
		selectedExamples.push(examples.splice(exampleIndex, 1)[0]);

		if (examples.length === 0) {
			availableActionIndices.splice(randomIndex, 1);
		}
	}

	return formatSelectedExamples(
		selectedExamples,
		buildDeterministicSeed(seed, "names"),
	);
};

function formatActionCallExample(example: {
	user: string;
	actions: readonly string[];
	params?: Record<string, Record<string, unknown>>;
}): string {
	const paramsByAction = example.params ?? {};
	const assistantPayload: Record<string, unknown> = {
		actions: [...example.actions],
	};

	if (Object.keys(paramsByAction).length > 0) {
		assistantPayload.params = paramsByAction;
	}

	return `User: ${example.user}\nAssistant:\n${JSON.stringify(assistantPayload, null, 2)}`;
}

/** Render canonical JSON action-call examples. */
export function composeActionCallExamples(
	actionsData: Action[],
	maxExamples: number,
): string {
	if (!actionsData.length || maxExamples <= 0) return "";

	const blocks: string[] = [];
	const sorted = [...actionsData].sort((a, b) => a.name.localeCompare(b.name));

	for (const action of sorted) {
		const doc = actionDocByName[action.name];
		if (!doc?.exampleCalls || doc.exampleCalls.length === 0) continue;
		for (const ex of doc.exampleCalls) {
			blocks.push(formatActionCallExample(ex));
			if (blocks.length >= maxExamples) return blocks.join("\n\n");
		}
	}

	return blocks.join("\n\n");
}

const formatSelectedExamples = (
	examples: ActionExample[][],
	seed = "actions",
): string => {
	const MAX_NAME_PLACEHOLDERS = 5;

	return examples
		.map((example, index) => {
			const randomNames = getDeterministicNames(
				MAX_NAME_PLACEHOLDERS,
				buildDeterministicSeed(seed, index),
			);

			const conversation = example
				.map((message) => {
					let messageText = `${message.name}: ${message.content.text}`;

					for (let i = 0; i < randomNames.length; i++) {
						messageText = messageText.replaceAll(
							`{{name${i + 1}}}`,
							randomNames[i],
						);
					}

					return messageText;
				})
				.join("\n");

			return `\n${conversation}`;
		})
		.join("\n");
};

function getExampleActionHints(example: ActionExample[]): string[] {
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
			for (const action of content.actions) {
				if (typeof action === "string" && action.trim()) {
					hints.add(action.trim());
				}
			}
		}
	}
	return [...hints];
}

function formatPromptScalar(value: unknown): string {
	if (value == null) return "null";
	if (typeof value === "string") {
		return value.replace(/\s+/g, " ").trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => formatPromptScalar(item))
			.filter(Boolean)
			.join("|");
	}
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(([key, entry]) => `${key}:${formatPromptScalar(entry)}`)
			.join(",");
	}
	return String(value);
}

function formatActionExampleSummary(action: Action): string | null {
	const examples = action.examples ?? [];
	if (!Array.isArray(examples) || examples.length === 0) {
		return null;
	}

	for (const example of examples) {
		if (!Array.isArray(example) || example.length === 0) {
			continue;
		}

		const userMessage = example[0]?.content?.text?.trim();
		const actionHints = getExampleActionHints(example);
		if (!userMessage) {
			continue;
		}
		if (actionHints.length === 0) {
			return `User: ${formatPromptScalar(userMessage)} -> actions: ${action.name}`;
		}

		return `User: ${formatPromptScalar(userMessage)} -> actions: ${actionHints.join(", ")}`;
	}

	return null;
}

function shuffleActions<T>(items: T[], seed = "actions"): T[] {
	return deterministicShuffle(items, seed);
}

function collectActionSimiles(action: Action): string[] {
	return [
		...new Set(
			(action.similes ?? [])
				.filter((simile): simile is string => typeof simile === "string")
				.map((simile) => simile.trim()),
		),
	].filter((simile) => simile.length > 0);
}

function collectActionTags(action: Action): string[] {
	return [
		...new Set(
			(action.tags ?? [])
				.filter((tag): tag is string => typeof tag === "string")
				.map((tag) => tag.trim()),
		),
	].filter((tag) => tag.length > 0 && tag !== "always-include");
}

function renderCompressedDescription(item: {
	description?: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
}): string {
	return (
		item.descriptionCompressed ??
		item.compressedDescription ??
		(item.description ? compressPromptDescription(item.description) : "")
	);
}

export function formatActionNames(actions: Action[], seed = "actions"): string {
	if (!actions?.length) return "";

	return shuffleActions(actions, buildDeterministicSeed(seed, "names"))
		.map((action) => action.name)
		.join(", ");
}

export function formatActions(actions: Action[], seed = "actions"): string {
	if (!actions?.length) return "";

	const actionRows = shuffleActions(
		actions,
		buildDeterministicSeed(seed, "descriptions"),
	).map((action) => ({
		name: action.name,
		description:
			renderCompressedDescription(action) || "No description available",
		params:
			action.parameters && action.parameters.length > 0
				? formatActionParameters(action.parameters)
				: "",
		aliases: collectActionSimiles(action),
		tags: collectActionTags(action),
		example: formatActionExampleSummary(action) ?? "",
	}));

	return JSON.stringify({ actions: actionRows }, null, 2);
}

export function formatActionParameters(parameters: ActionParameter[]): string {
	if (!parameters?.length) return "";

	return parameters
		.map((param) => {
			const typeStr = formatParameterType(param.schema);
			const modifiers: string[] = [];

			if (param.schema.enum?.length) {
				modifiers.push(`values=${param.schema.enum.join("|")}`);
			}

			if (param.schema.default !== undefined) {
				modifiers.push(`default=${formatPromptScalar(param.schema.default)}`);
			}

			if (param.examples && param.examples.length > 0) {
				modifiers.push(
					`examples=${param.examples.map((v) => formatPromptScalar(v)).join("|")}`,
				);
			}

			const suffix = modifiers.length > 0 ? ` [${modifiers.join("; ")}]` : "";
			return `${param.name}${param.required ? "" : "?"}:${typeStr}${suffix} - ${renderCompressedDescription(param)}`;
		})
		.join("; ");
}

function formatParameterType(schema: ActionParameterSchema): string {
	if (schema.anyOf?.length) {
		return `(${schema.anyOf.map(formatParameterType).join(" | ")})`;
	}
	if (schema.oneOf?.length) {
		return schema.oneOf.map(formatParameterType).join(" | ");
	}

	const primitiveType = schema.type;
	switch (primitiveType) {
		case "string":
			return "string";
		case "number":
			return schema.minimum !== undefined || schema.maximum !== undefined
				? `number [${schema.minimum ?? "∞"}-${schema.maximum ?? "∞"}]`
				: "number";
		case "boolean":
			return "boolean";
		case "array":
			return schema.items
				? `array of ${formatParameterType(schema.items)}`
				: "array";
		case "object":
			return "object";
		case undefined:
			return "unknown";
		default:
			return primitiveType;
	}
}

export function parseActionParams(
	paramsInput: unknown,
): Map<string, ActionParameters> {
	const parsed =
		typeof paramsInput === "string"
			? parseActionParamsJson(paramsInput)
			: (paramsInput ?? null);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return new Map();
	}

	const record = parsed as Record<string, unknown>;
	const candidate =
		record.params &&
		typeof record.params === "object" &&
		!Array.isArray(record.params)
			? (record.params as Record<string, unknown>)
			: record;
	const result = new Map<string, ActionParameters>();

	for (const [actionName, paramsValue] of Object.entries(candidate)) {
		if (
			!paramsValue ||
			typeof paramsValue !== "object" ||
			Array.isArray(paramsValue)
		) {
			continue;
		}

		const params: ActionParameters = {};
		for (const [paramName, paramValue] of Object.entries(paramsValue)) {
			params[paramName] = toActionParameterValue(paramValue);
		}

		if (Object.keys(params).length > 0) {
			result.set(actionName.trim().toUpperCase(), params);
		}
	}

	return result;
}

function parseActionParamsJson(input: string): Record<string, unknown> | null {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}

	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function toActionParameterValue(value: unknown): ActionParameters[string] {
	if (value === null || value === undefined) {
		return null;
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value as ActionParameterValue;
	}

	if (Array.isArray(value)) {
		return value.map((entry) => toActionParameterValue(entry));
	}

	if (value && typeof value === "object") {
		const normalized: ActionParameters = {};
		for (const [key, entry] of Object.entries(value)) {
			normalized[key] = toActionParameterValue(entry);
		}
		return normalized;
	}

	return value === undefined ? null : String(value);
}

export function validateActionParams(
	action: Action,
	extractedParams: ActionParameters | undefined,
): { valid: boolean; params: ActionParameters | undefined; errors: string[] } {
	const errors: string[] = [];
	const params: ActionParameters = {};

	if (!action.parameters || action.parameters.length === 0) {
		return { valid: true, params: undefined, errors: [] };
	}

	for (const paramDef of action.parameters) {
		const extractedValue = coerceActionParamValue(
			paramDef,
			extractedParams ? extractedParams[paramDef.name] : undefined,
		);

		if (extractedValue === undefined || extractedValue === null) {
			if (paramDef.required) {
				errors.push(
					`Required parameter '${paramDef.name}' was not provided for action ${action.name}`,
				);
			} else if (paramDef.schema.default !== undefined) {
				params[paramDef.name] = paramDef.schema.default;
			}
		} else {
			const typeError = validateParamType(paramDef, extractedValue);
			if (typeError) {
				if (paramDef.required) {
					errors.push(typeError);
				} else if (paramDef.schema.default !== undefined) {
					params[paramDef.name] = paramDef.schema.default;
				}
			} else {
				params[paramDef.name] = extractedValue;
			}
		}
	}

	return {
		valid: errors.length === 0,
		params: Object.keys(params).length > 0 ? params : undefined,
		errors,
	};
}

function coerceActionParamValue(
	paramDef: ActionParameter,
	value: ActionParameters[string] | undefined,
): ActionParameters[string] | undefined {
	if (
		paramDef.schema.type === "string" &&
		(typeof value === "number" || typeof value === "bigint")
	) {
		return String(value);
	}

	if (paramDef.schema.type !== "array" || Array.isArray(value)) {
		return value;
	}

	if (typeof value !== "string") {
		return value;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return [];
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parsed.map((entry) => toActionParameterValue(entry));
			}
		} catch {
			// Fall through to the permissive string coercion path below.
		}
	}

	if (paramDef.schema.items?.type !== "string") {
		return value;
	}

	const SAFE_SPLIT_LIMIT = 10_000;
	const safeTrimmed =
		trimmed.length > SAFE_SPLIT_LIMIT
			? trimmed.slice(0, SAFE_SPLIT_LIMIT)
			: trimmed;
	const splitValues = safeTrimmed
		.split(/\|\||,|\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (splitValues.length === 0) {
		return [];
	}

	return splitValues;
}

type ValidatableParamValue =
	| ActionParameterValue
	| ActionParameters
	| ActionParameterValue[]
	| ActionParameters[]
	| JsonValue;

function validateParamType(
	paramDef: ActionParameter,
	value: ValidatableParamValue,
): string | undefined {
	const { schema, name } = paramDef;

	switch (schema.type) {
		case "string": {
			if (typeof value !== "string") {
				return `Parameter '${name}' expected string, got ${typeof value}`;
			}
			const enumValues = schema.enumValues ?? schema.enum;
			if (enumValues && !enumValues.includes(value)) {
				return `Parameter '${name}' value '${value}' not in allowed values: ${enumValues.join(", ")}`;
			}
			if (schema.pattern) {
				const regex = new RegExp(schema.pattern);
				if (!regex.test(value)) {
					return `Parameter '${name}' value '${value}' does not match pattern: ${schema.pattern}`;
				}
			}
			break;
		}

		case "number":
			if (typeof value !== "number") {
				return `Parameter '${name}' expected number, got ${typeof value}`;
			}
			if (schema.minimum !== undefined && value < schema.minimum) {
				return `Parameter '${name}' value ${value} is below minimum ${schema.minimum}`;
			}
			if (schema.maximum !== undefined && value > schema.maximum) {
				return `Parameter '${name}' value ${value} is above maximum ${schema.maximum}`;
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return `Parameter '${name}' expected boolean, got ${typeof value}`;
			}
			break;

		case "array":
			if (!Array.isArray(value)) {
				return `Parameter '${name}' expected array, got ${typeof value}`;
			}
			break;

		case "object":
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return `Parameter '${name}' expected object, got ${typeof value}`;
			}
			break;
	}

	return undefined;
}
