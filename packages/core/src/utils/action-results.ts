/**
 * Projects action and tool results into model context without discarding their
 * text, errors, structured data, or earlier results. Size warnings remain
 * diagnostic only: model/provider boundaries must reject unsupported request
 * sizes explicitly instead of silently changing the prompt.
 */
import type { ActionResult, ProviderDataRecord } from "../types/components";

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

/**
 * Serializes complete action data for model context. `maxChars` remains in the
 * signature for source compatibility but no longer authorizes content loss.
 */
export function formatActionResultDataForPrompt(
	data: ProviderDataRecord,
	_maxChars?: number,
): string {
	return JSON.stringify(data);
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

export function formatCompleteActionResultText(
	text: string,
	_maxChars: number,
	reference?: string,
): string {
	const trimmed = text.trim();
	return reference ? `${trimmed}\n\nFull output: ${reference}` : trimmed;
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
			? formatCompleteActionResultText(result.text, 0, textReference)
			: result.text;
	const errorText = stringifyActionResultError(result.error);
	const error =
		errorText === undefined
			? result.error
			: formatCompleteActionResultText(errorText, 0, errorReference);

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
		maxResults: _maxResults,
		preserveAbsoluteIndex: _preserveAbsoluteIndex = true,
		includeData = false,
	} = options;

	if (actionResults.length === 0) {
		return "No action results available.";
	}

	const rendered = actionResults;

	return [
		header,
		...rendered.map((result, index) => {
			const displayIndex = index + 1;
			const status = result.success === false ? "failed" : "succeeded";
			const lines = [
				`${displayIndex}. ${getActionResultActionName(result)} - ${status}`,
			];
			if (typeof result.text === "string" && result.text.trim()) {
				lines.push(`Output: ${formatCompleteActionResultText(result.text, 0)}`);
			}

			const errorText = stringifyActionResultError(result.error);
			if (errorText) {
				lines.push(`Error: ${formatCompleteActionResultText(errorText, 0)}`);
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
