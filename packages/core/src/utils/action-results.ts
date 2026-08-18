/**
 * Bounds how much of a (potentially huge) action/tool result reaches prompt
 * state. Estimates token cost from character length, truncates the text and
 * error fields in the middle while preserving head and tail, and surfaces a
 * filesystem reference (e.g. `fullOutputPath`) to the complete output when one
 * is present in the result data. `collectActionResultSizeWarnings` flags fields
 * over a token threshold, and `formatActionResultsForPrompt` renders the most
 * recent results (capped at `MAX_PROMPTED_ACTION_RESULTS`) into the prompt block.
 */
import type { ActionResult, ProviderDataRecord } from "../types/components";
import { tailWellFormed, truncateWellFormed } from "./well-formed";

export const MAX_PROMPTED_ACTION_RESULTS = 8;
export const MAX_ACTION_RESULT_TEXT_CHARS = 4000;
export const MAX_ACTION_RESULT_ERROR_CHARS = 2000;
export const MAX_ACTION_RESULT_DATA_CHARS = 4000;
export const ACTION_RESULT_OVERSIZE_WARNING_TOKENS = 10000;
export const ACTION_RESULT_TOKEN_ESTIMATE_CHARS = 4;

export const ACTION_RESULT_FULL_OUTPUT_REFERENCE_KEYS = new Set([
	"fullOutputPath",
	"fullOutputFile",
	"outputPath",
	"outputFile",
	"outputFilePath",
	"stdoutPath",
	"stdoutFile",
	"artifactPath",
	"resultPath",
	"filePath",
	"path",
]);

export const ACTION_RESULT_FULL_ERROR_REFERENCE_KEYS = new Set([
	"fullErrorPath",
	"fullErrorFile",
	"errorPath",
	"errorFile",
	"stderrPath",
	"stderrFile",
	"logPath",
	"logFile",
]);

export type ActionResultTextField = "text" | "error";

export interface ActionResultSizeWarning {
	actionName: string;
	field: ActionResultTextField;
	rawCharLength: number;
	estimatedTokens: number;
	thresholdTokens: number;
}

export interface ActionResultReferences {
	text?: string;
	error?: string;
}

const PROMPT_DATA_PRIORITY_KEYS = [
	"actionName",
	"awaitingUserInput",
	"slug",
	"op",
	"status",
	"id",
] as const;

function compactPromptDataValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") {
		return value.length <= 512
			? value
			: `${truncateWellFormed(value, 496)}...[truncated]`;
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (depth >= 2) {
		return Array.isArray(value)
			? `[array with ${value.length} item(s)]`
			: "[nested object omitted]";
	}
	if (Array.isArray(value)) {
		const retained = value
			.slice(0, 4)
			.map((entry) => compactPromptDataValue(entry, depth + 1));
		if (value.length > retained.length) {
			retained.push(`[${value.length - retained.length} item(s) omitted]`);
		}
		return retained;
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.slice(0, 8)
				.map(([key, entry]) => [key, compactPromptDataValue(entry, depth + 1)]),
		);
	}
	return String(value);
}

/**
 * Serializes action data as complete JSON within the evaluator prompt budget.
 * Small payloads remain byte-for-byte complete. Oversized payloads retain
 * control scalars first and replace bulky nested values with explicit markers.
 */
export function formatActionResultDataForPrompt(
	data: ProviderDataRecord,
	maxChars = MAX_ACTION_RESULT_DATA_CHARS,
): string {
	const full = JSON.stringify(data);
	if (full.length <= maxChars) return full;

	const priority = new Set<string>(PROMPT_DATA_PRIORITY_KEYS);
	const orderedEntries = [
		...PROMPT_DATA_PRIORITY_KEYS.flatMap((key) =>
			Object.hasOwn(data, key) ? [[key, data[key]] as const] : [],
		),
		...Object.entries(data).filter(([key]) => !priority.has(key)),
	];
	const projected: Record<string, unknown> = {};
	for (const [key, value] of orderedEntries) {
		const compact = compactPromptDataValue(value);
		const candidate = { ...projected, [key]: compact, __truncated: true };
		if (JSON.stringify(candidate).length <= maxChars) {
			projected[key] = compact;
		}
	}
	projected.__truncated = true;
	return JSON.stringify(projected);
}

export function estimateActionResultTokens(text: string): number {
	return Math.ceil(text.length / ACTION_RESULT_TOKEN_ESTIMATE_CHARS);
}

export function getActionResultActionName(result: ActionResult): string {
	const actionNameValue = result.data?.actionName;
	return typeof actionNameValue === "string" && actionNameValue.trim()
		? actionNameValue.trim()
		: "Unknown Action";
}

export function stringifyActionResultError(
	error: ActionResult["error"],
): string | undefined {
	if (error === undefined || error === null) {
		return undefined;
	}
	return error instanceof Error ? error.message : String(error);
}

function getReferenceFromData(
	data: ProviderDataRecord | undefined,
	keys: Set<string>,
): string | undefined {
	if (!data) {
		return undefined;
	}
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

export function getActionResultReference(
	result: ActionResult,
	field: ActionResultTextField,
): string | undefined {
	return getReferenceFromData(
		result.data,
		field === "text"
			? ACTION_RESULT_FULL_OUTPUT_REFERENCE_KEYS
			: ACTION_RESULT_FULL_ERROR_REFERENCE_KEYS,
	);
}

export function truncateMiddle(
	text: string,
	maxChars: number,
	reference?: string,
): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	const markerFor = (omittedChars: number) =>
		`\n\n[... ${omittedChars} chars omitted ...]\n\n`;

	// Reserve space using the largest possible count. Safe cuts may retain one
	// fewer code unit at either boundary, so derive the displayed count from the
	// actual slices rather than the requested budget.
	const retainedBudget = Math.max(
		0,
		maxChars - markerFor(trimmed.length).length,
	);
	const head = truncateWellFormed(trimmed, Math.ceil(retainedBudget / 2));
	const tail = tailWellFormed(trimmed, Math.floor(retainedBudget / 2));
	const marker = markerFor(trimmed.length - head.length - tail.length);
	const rendered =
		head.length + marker.length + tail.length <= maxChars
			? `${head}${marker}${tail}`
			: truncateWellFormed(trimmed, maxChars);

	return reference ? `${rendered}\n\nFull output: ${reference}` : rendered;
}

export function collectActionResultSizeWarnings(
	result: ActionResult,
	thresholdTokens = ACTION_RESULT_OVERSIZE_WARNING_TOKENS,
): ActionResultSizeWarning[] {
	const actionName = getActionResultActionName(result);
	const fields: Array<{ field: ActionResultTextField; text?: string }> = [
		{ field: "text", text: result.text },
		{ field: "error", text: stringifyActionResultError(result.error) },
	];

	return fields.flatMap(({ field, text }) => {
		if (!text) {
			return [];
		}
		const estimatedTokens = estimateActionResultTokens(text);
		return estimatedTokens > thresholdTokens
			? [
					{
						actionName,
						field,
						rawCharLength: text.length,
						estimatedTokens,
						thresholdTokens,
					},
				]
			: [];
	});
}

export function trimActionResultForPromptState<T extends ActionResult>(
	result: T,
	references: ActionResultReferences = {},
): T {
	const textReference =
		references.text ?? getActionResultReference(result, "text");
	const errorReference =
		references.error ?? getActionResultReference(result, "error");
	const data: ProviderDataRecord = { ...(result.data ?? {}) };
	if (textReference) {
		data.fullOutputPath = textReference;
	}
	if (errorReference) {
		data.fullErrorPath = errorReference;
	}

	const text =
		typeof result.text === "string"
			? truncateMiddle(result.text, MAX_ACTION_RESULT_TEXT_CHARS, textReference)
			: result.text;
	const errorText = stringifyActionResultError(result.error);
	const error =
		errorText === undefined
			? result.error
			: truncateMiddle(
					errorText,
					MAX_ACTION_RESULT_ERROR_CHARS,
					errorReference,
				);

	return {
		...result,
		...(text !== undefined ? { text } : {}),
		...(error !== undefined ? { error } : {}),
		data,
	} as T;
}

export function formatActionResultsForPrompt(
	actionResults: ActionResult[],
	options: {
		header?: string;
		maxResults?: number;
		preserveAbsoluteIndex?: boolean;
		includeData?: boolean;
	} = {},
): string {
	const {
		header = "# Current Chain Action Results",
		maxResults = MAX_PROMPTED_ACTION_RESULTS,
		preserveAbsoluteIndex = true,
		includeData = false,
	} = options;

	if (actionResults.length === 0) {
		return "No action results available.";
	}

	const rendered =
		actionResults.length > maxResults
			? actionResults.slice(-maxResults)
			: actionResults;
	const truncatedCount = actionResults.length - rendered.length;
	const omittedNote =
		truncatedCount > 0
			? [`(${truncatedCount} earlier action result(s) omitted.)`]
			: [];

	return [
		header,
		...omittedNote,
		...rendered.map((result, index) => {
			const displayIndex = preserveAbsoluteIndex
				? truncatedCount + index + 1
				: index + 1;
			const status = result.success === false ? "failed" : "succeeded";
			const lines = [
				`${displayIndex}. ${getActionResultActionName(result)} - ${status}`,
			];
			if (typeof result.text === "string" && result.text.trim()) {
				lines.push(
					`Output: ${truncateMiddle(result.text, MAX_ACTION_RESULT_TEXT_CHARS)}`,
				);
			}

			const errorText = stringifyActionResultError(result.error);
			if (errorText) {
				lines.push(
					`Error: ${truncateMiddle(errorText, MAX_ACTION_RESULT_ERROR_CHARS)}`,
				);
			}

			const modelData = result.promptData ?? result.data;
			if (includeData && modelData && Object.keys(modelData).length > 0) {
				lines.push(`Data: ${formatActionResultDataForPrompt(modelData)}`);
			}

			const outputReference = getActionResultReference(result, "text");
			if (
				outputReference &&
				!lines.some((line) => line.includes(outputReference))
			) {
				lines.push(`Full output: ${outputReference}`);
			}

			const errorReference = getActionResultReference(result, "error");
			if (
				errorReference &&
				!lines.some((line) => line.includes(errorReference))
			) {
				lines.push(`Full error: ${errorReference}`);
			}

			return lines.join("\n");
		}),
	].join("\n\n");
}
