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
import {
	encodeToonValue,
	parseToonActionParams,
	tryParseToonValue,
} from "./utils/toon";
import { parseJSONObjectFromText } from "./utils.ts";

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
	params?: Record<string, Record<string, string | number | boolean | null>>;
}): string {
	const paramsByAction = example.params ?? {};
	const assistantPayload: Record<string, unknown> = {
		actions: [...example.actions],
	};

	if (Object.keys(paramsByAction).length > 0) {
		assistantPayload.params = paramsByAction;
	}

	return `User: ${example.user}\nAssistant:\n${encodeToonValue(assistantPayload)}`;
}

/**
 * Render canonical action-call examples (including <params> blocks).
 *
 * Deterministic ordering is important to keep tests stable and avoid prompt churn.
 */
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
			return `User: ${JSON.stringify(userMessage)} -> actions: ${action.name}`;
		}

		return `User: ${JSON.stringify(userMessage)} -> actions: ${actionHints.join(", ")}`;
	}

	return null;
}

function shuffleActions<T>(items: T[], seed = "actions"): T[] {
	return deterministicShuffle(items, seed);
}

function formatActionSimiles(action: Action): string | null {
	const similes = [
		...new Set(
			(action.similes ?? [])
				.filter((simile): simile is string => typeof simile === "string")
				.map((simile) => simile.trim()),
		),
	].filter((simile) => simile.length > 0);

	if (similes.length === 0) {
		return null;
	}

	return `  aliases[${similes.length}]: ${similes.join(", ")}`;
}

function formatActionTags(action: Action): string | null {
	const tags = [
		...new Set(
			(action.tags ?? [])
				.filter((tag): tag is string => typeof tag === "string")
				.map((tag) => tag.trim()),
		),
	].filter((tag) => tag.length > 0 && tag !== "always-include");

	if (tags.length === 0) {
		return null;
	}

	return `  tags[${tags.length}]: ${tags.join(", ")}`;
}

export function formatActionNames(actions: Action[], seed = "actions"): string {
	if (!actions?.length) return "";

	return shuffleActions(actions, buildDeterministicSeed(seed, "names"))
		.map((action) => action.name)
		.join(", ");
}

export function formatActions(actions: Action[], seed = "actions"): string {
	if (!actions?.length) return "";

	const actionLines = shuffleActions(
		actions,
		buildDeterministicSeed(seed, "descriptions"),
	)
		.map((action) => {
			const lines = [
				`- ${action.name}: ${action.description || "No description available"}`,
			];
			const exampleSummary = formatActionExampleSummary(action);
			const similes = formatActionSimiles(action);
			const tags = formatActionTags(action);

			if (similes) {
				lines.push(similes);
			}

			if (tags) {
				lines.push(tags);
			}

			if (action.parameters && action.parameters.length > 0) {
				lines.push(
					`  params[${action.parameters.length}]: ${formatActionParameters(
						action.parameters,
					)}`,
				);
			}

			if (exampleSummary) {
				lines.push(`  example: ${exampleSummary}`);
			}

			return lines.join("\n");
		})
		.join("\n");

	return `actions[${actions.length}]:\n${actionLines}`;
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
				modifiers.push(`default=${JSON.stringify(param.schema.default)}`);
			}

			if (param.examples && param.examples.length > 0) {
				modifiers.push(
					`examples=${param.examples.map((v) => JSON.stringify(v)).join("|")}`,
				);
			}

			const suffix = modifiers.length > 0 ? ` [${modifiers.join("; ")}]` : "";
			return `${param.name}${param.required ? "" : "?"}:${typeStr}${suffix} - ${param.description}`;
		})
		.join("; ");
}

function formatParameterType(schema: ActionParameterSchema): string {
	switch (schema.type) {
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
		default:
			return schema.type;
	}
}

/**
 * Parse action parameters from either the new nested format or the legacy flat format.
 *
 * New format (preferred):
 *   <actions>
 *     <action><name>ACTION1</name><params><p1>v1</p1></params></action>
 *   </actions>
 *
 * Legacy format (backward-compat – previously stored in content.params):
 *   <ACTION1><p1>v1</p1></ACTION1>
 */
export function parseActionParams(
	paramsInput: unknown,
): Map<string, ActionParameters> {
	const toonParams = parseToonActionParams(paramsInput);
	if (toonParams.size > 0) {
		return toonParams;
	}

	const result = new Map<string, ActionParameters>();
	if (!paramsInput || typeof paramsInput !== "string") {
		return result;
	}

	const paramsXml = paramsInput;

	// ---- New nested format: look for <action> children ----
	const actionChildren = extractXmlChildren(paramsXml);
	const actionElements = actionChildren.filter((c) => c.key === "action");

	if (actionElements.length > 0) {
		for (const { value: actionXml } of actionElements) {
			const children = extractXmlChildren(actionXml);
			const nameEntry = children.find((c) => c.key === "name");
			const paramsEntry = children.find((c) => c.key === "params");

			if (!nameEntry) continue;
			const actionName = nameEntry.value.trim().toUpperCase();
			if (!actionName) continue;

			if (paramsEntry) {
				const paramPairs = extractXmlChildren(paramsEntry.value);
				const actionParams: ActionParameters = {};
				for (const { key: paramName, value: paramValue } of paramPairs) {
					actionParams[paramName] = parseParamValue(paramValue);
				}
				if (Object.keys(actionParams).length > 0) {
					result.set(actionName, actionParams);
				}
			}
		}
		return result;
	}

	// ---- Legacy flat format: <ACTION_NAME><param>value</param></ACTION_NAME> ----
	for (const { key: actionName, value: actionParamsXml } of actionChildren) {
		const params = extractXmlChildren(actionParamsXml);
		const actionParams: ActionParameters = {};

		for (const { key: paramName, value: paramValue } of params) {
			actionParams[paramName] = parseParamValue(paramValue);
		}

		if (Object.keys(actionParams).length === 0) {
			const structuredParams =
				parseJSONObjectFromText(actionParamsXml) ??
				tryParseToonValue(actionParamsXml);
			if (
				structuredParams &&
				typeof structuredParams === "object" &&
				!Array.isArray(structuredParams)
			) {
				for (const [paramName, paramValue] of Object.entries(
					structuredParams,
				)) {
					actionParams[paramName] = toActionParameterValue(paramValue);
				}
			}
		}

		if (Object.keys(actionParams).length > 0) {
			result.set(actionName.toUpperCase(), actionParams);
		}
	}

	return result;
}

function extractXmlChildren(
	xml: string,
): Array<{ key: string; value: string }> {
	const pairs: Array<{ key: string; value: string }> = [];
	const length = xml.length;
	let i = 0;

	while (i < length) {
		const openIdx = xml.indexOf("<", i);
		if (openIdx === -1) break;

		if (
			xml.startsWith("</", openIdx) ||
			xml.startsWith("<!--", openIdx) ||
			xml.startsWith("<?", openIdx)
		) {
			i = openIdx + 1;
			continue;
		}

		let j = openIdx + 1;
		let tag = "";
		while (j < length) {
			const ch = xml[j];
			if (/^[A-Za-z0-9_-]$/.test(ch)) {
				tag += ch;
				j++;
				continue;
			}
			break;
		}
		if (!tag) {
			i = openIdx + 1;
			continue;
		}

		const startTagEnd = xml.indexOf(">", j);
		if (startTagEnd === -1) break;

		const startTagText = xml.slice(openIdx, startTagEnd + 1);
		if (/\/\s*>$/.test(startTagText)) {
			i = startTagEnd + 1;
			continue;
		}

		const closeSeq = `</${tag}>`;
		let depth = 1;
		let searchStart = startTagEnd + 1;
		while (depth > 0 && searchStart < length) {
			const nextOpen = xml.indexOf(`<${tag}`, searchStart);
			const nextClose = xml.indexOf(closeSeq, searchStart);
			if (nextClose === -1) break;

			if (nextOpen !== -1 && nextOpen < nextClose) {
				const nestedStartEnd = xml.indexOf(">", nextOpen + 1);
				if (nestedStartEnd === -1) break;
				const nestedStartText = xml.slice(nextOpen, nestedStartEnd + 1);
				if (!/\/\s*>$/.test(nestedStartText)) {
					depth++;
				}
				searchStart = nestedStartEnd + 1;
			} else {
				depth--;
				searchStart = nextClose + closeSeq.length;
			}
		}

		if (depth !== 0) {
			i = startTagEnd + 1;
			continue;
		}

		const closeIdx = searchStart - closeSeq.length;
		const innerRaw = xml.slice(startTagEnd + 1, closeIdx).trim();

		// LLM-tolerance: if the tag is a generic `<param name="X">value</param>`,
		// prefer the `name` attribute as the key. Some planners emit attribute-
		// named params instead of tag-named ones, and the canonical handler
		// expects key=actual-param-name not key="param".
		let resolvedKey = tag;
		if (tag.toLowerCase() === "param") {
			const nameAttrMatch = startTagText.match(
				/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/,
			);
			const candidate =
				nameAttrMatch?.[1] ?? nameAttrMatch?.[2] ?? nameAttrMatch?.[3];
			if (candidate && candidate.length > 0) {
				resolvedKey = candidate;
			}
		}

		pairs.push({ key: resolvedKey, value: innerRaw });
		i = searchStart;
	}

	return pairs;
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

function parseParamValue(value: string): string | number | boolean | null {
	if (!value || value === "") return null;

	const lower = value.toLowerCase();
	if (lower === "true") return true;
	if (lower === "false") return false;
	if (lower === "null") return null;

	const num = Number(value);
	if (!Number.isNaN(num) && value.trim() !== "") {
		return num;
	}

	return value;
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
			// Fall through to the permissive toon/string coercion paths below.
		}
	}

	const xmlChildren = extractXmlChildren(trimmed);
	if (xmlChildren.length > 0) {
		return xmlChildren.map(({ value: childValue }) =>
			toActionParameterValue(childValue),
		);
	}

	const toonValue = tryParseToonValue(trimmed);
	if (Array.isArray(toonValue)) {
		return toonValue.map((entry) => toActionParameterValue(entry));
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
