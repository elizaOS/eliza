/**
 * @module extraction
 * @description LLM-based field extraction from natural language
 *
 * Unlike traditional forms where users fill in specific fields, agent-native
 * forms let users provide information naturally. This module extracts
 * structured data from natural language using LLM.
 */

import type { IAgentRuntime, JsonValue } from "../../../types/index.ts";
import { ModelType, parseKeyValueXml } from "../../../types/index.ts";
import type { TemplateValues } from "./template.ts";
import { resolveControlTemplates } from "./template.ts";
import type {
	ExtractionResult,
	FormControl,
	FormDefinition,
	FormIntent,
	IntentResult,
} from "./types.ts";
import { getTypeHandler, parseValue, validateField } from "./validation.ts";

type ExtractionXmlField = {
	key?: string;
	value?: JsonValue;
	confidence?: string | number;
	reasoning?: string;
	is_correction?: boolean | string;
};

type ExtractionXmlResponse = {
	intent?: string;
	extractions?:
		| { field?: ExtractionXmlField | ExtractionXmlField[] }
		| ExtractionXmlField[];
};

type SingleFieldXmlResponse = {
	found?: string | boolean;
	value?: JsonValue;
	confidence?: string | number;
	reasoning?: string;
};

type CorrectionXmlField = {
	field?: string;
	old_value?: JsonValue;
	new_value?: JsonValue;
	confidence?: string | number;
};

type CorrectionXmlResponse = {
	has_correction?: string | boolean;
	corrections?:
		| { correction?: CorrectionXmlField | CorrectionXmlField[] }
		| CorrectionXmlField[];
};

// ============================================================================
// LLM-BASED EXTRACTION
// ============================================================================

/**
 * Extract field values and detect intent from user message using LLM.
 */
export async function llmIntentAndExtract(
	runtime: IAgentRuntime,
	text: string,
	form: FormDefinition,
	controls: FormControl[],
	templateValues?: TemplateValues,
): Promise<IntentResult> {
	const resolvedControls = templateValues
		? controls.map((control) =>
				resolveControlTemplates(control, templateValues),
			)
		: controls;

	const fieldsDescription = resolvedControls
		.filter((c) => !c.hidden)
		.map((c) => {
			const handler = getTypeHandler(c.type);
			const typeHint = handler?.extractionPrompt || c.type;
			const hints = c.extractHints?.join(", ") || "";
			const options = c.options?.map((o) => o.value).join(", ") || "";

			return `- ${c.key} (${c.label}): ${c.description || typeHint}${hints ? ` [hints: ${hints}]` : ""}${options ? ` [options: ${options}]` : ""}`;
		})
		.join("\n");

	const prompt = `You are extracting structured data from a user's natural language message.

FORM: ${form.name}
${form.description ? `DESCRIPTION: ${form.description}` : ""}

FIELDS TO EXTRACT:
${fieldsDescription}

USER MESSAGE:
"${text}"

INSTRUCTIONS:
1. Determine the user's intent:
   - fill_form: They are providing information for form fields
   - submit: They want to submit/complete the form ("done", "submit", "finish", "that's all")
   - stash: They want to save for later ("save for later", "pause", "hold on")
   - restore: They want to resume a saved form ("resume", "continue", "pick up where")
   - cancel: They want to cancel ("cancel", "abort", "nevermind", "forget it")
   - undo: They want to undo last change ("undo", "go back", "wait no")
   - skip: They want to skip current field ("skip", "pass", "don't know")
   - explain: They want explanation ("why?", "what's that for?")
   - example: They want an example ("example?", "like what?")
   - progress: They want progress update ("how far?", "status")
   - autofill: They want to use saved values ("same as last time")
   - other: None of the above

2. For fill_form intent, extract all field values mentioned.
   - For each extracted value, provide a confidence score (0.0-1.0)
   - Note if this appears to be a correction to a previous value

Respond using TOON like this:
intent: fill_form, submit, stash, restore, cancel, undo, skip, explain, example, progress, autofill, or other
extractions[N]{key,value,confidence,reasoning,is_correction}:
  field_key,extracted_value,0.9,why this value,false

Example:
intent: fill_form
extractions[2]{key,value,confidence,reasoning,is_correction}:
  name,Jane Doe,0.95,User said their name is Jane,false
  email,jane@example.com,0.9,Email mentioned in message,false

IMPORTANT: Your response must ONLY contain the TOON document above. No preamble or explanation.`;

	try {
		const runModel = runtime.useModel.bind(runtime);
		const response = await runModel(ModelType.TEXT_SMALL, {
			prompt,
			temperature: 0.1,
		});

		const parsed = parseExtractionResponse(response);

		for (const extraction of parsed.extractions) {
			const control = resolvedControls.find((c) => c.key === extraction.field);
			if (control) {
				if (typeof extraction.value === "string") {
					extraction.value = parseValue(extraction.value, control);
				}

				const validation = validateField(extraction.value, control);
				if (!validation.valid) {
					extraction.confidence = Math.min(extraction.confidence, 0.3);
					extraction.reasoning = `${extraction.reasoning || ""} (Validation failed: ${validation.error})`;
				}
			}
		}

		if (form.debug) {
			runtime.logger.debug(
				"[FormExtraction] LLM extraction result:",
				JSON.stringify(parsed),
			);
		}

		return parsed;
	} catch (error) {
		runtime.logger.error(
			"[FormExtraction] LLM extraction failed:",
			String(error),
		);
		return { intent: "other", extractions: [] };
	}
}

/**
 * Parse the structured extraction response (TOON-first, XML fallback).
 */
function parseExtractionResponse(response: string): IntentResult {
	const result: IntentResult = {
		intent: "other",
		extractions: [],
	};

	try {
		const parsed = parseKeyValueXml<ExtractionXmlResponse>(response);

		if (parsed) {
			const intentStr = parsed.intent?.toLowerCase() ?? "other";
			result.intent = isValidIntent(intentStr) ? intentStr : "other";

			if (parsed.extractions) {
				const fields = Array.isArray(parsed.extractions)
					? parsed.extractions
					: parsed.extractions.field
						? Array.isArray(parsed.extractions.field)
							? parsed.extractions.field
							: [parsed.extractions.field]
						: [];

				for (const field of fields) {
					if (field?.key) {
						const extraction: ExtractionResult = {
							field: String(field.key),
							value: field.value ?? null,
							confidence: parseFloat(String(field.confidence ?? "")) || 0.5,
							reasoning: field.reasoning ? String(field.reasoning) : undefined,
							isCorrection:
								field.is_correction === "true" || field.is_correction === true,
						};
						result.extractions.push(extraction);
					}
				}
			}
		}
	} catch (_error) {
		// Fallback: try regex extraction
		const intentMatch = response.match(/<intent>([^<]+)<\/intent>/);
		if (intentMatch) {
			const intentStr = intentMatch[1].toLowerCase().trim();
			result.intent = isValidIntent(intentStr) ? intentStr : "other";
		}

		const fieldMatches = response.matchAll(
			/<field>\s*<key>([^<]+)<\/key>\s*<value>([^<]*)<\/value>\s*<confidence>([^<]+)<\/confidence>/g,
		);
		for (const match of fieldMatches) {
			result.extractions.push({
				field: match[1].trim(),
				value: match[2].trim(),
				confidence: parseFloat(match[3]) || 0.5,
			});
		}
	}

	return result;
}

function isValidIntent(str: string): str is FormIntent {
	const validIntents: FormIntent[] = [
		"fill_form",
		"submit",
		"stash",
		"restore",
		"cancel",
		"undo",
		"skip",
		"explain",
		"example",
		"progress",
		"autofill",
		"other",
	];
	return validIntents.includes(str as FormIntent);
}

// ============================================================================
// SIMPLE EXTRACTION (for single-field targeted extraction)
// ============================================================================

/**
 * Extract a specific field value from user message.
 */
export async function extractSingleField(
	runtime: IAgentRuntime,
	text: string,
	control: FormControl,
	debug?: boolean,
	templateValues?: TemplateValues,
): Promise<ExtractionResult | null> {
	const resolvedControl = templateValues
		? resolveControlTemplates(control, templateValues)
		: control;
	const handler = getTypeHandler(resolvedControl.type);
	const typeHint = handler?.extractionPrompt || resolvedControl.type;

	const prompt = `Extract the ${resolvedControl.label} (${typeHint}) from this message:

"${text}"

${resolvedControl.description ? `Context: ${resolvedControl.description}` : ""}
${resolvedControl.extractHints?.length ? `Look for: ${resolvedControl.extractHints.join(", ")}` : ""}
${resolvedControl.options?.length ? `Valid options: ${resolvedControl.options.map((o) => o.value).join(", ")}` : ""}
${resolvedControl.example ? `Example: ${resolvedControl.example}` : ""}

Respond using TOON like this:
found: true or false
value: extracted value or empty if not found
confidence: 0.0 to 1.0
reasoning: brief explanation

  IMPORTANT: Your response must ONLY contain the TOON document above. No preamble or explanation.`;

	try {
		const runModel = runtime.useModel.bind(runtime);
		const response = await runModel(ModelType.TEXT_SMALL, {
			prompt,
			temperature: 0.1,
		});

		const parsed = parseKeyValueXml<SingleFieldXmlResponse>(response);

		const found = parsed?.found === true || parsed?.found === "true";
		if (found) {
			let value = parsed.value;

			if (typeof value === "string") {
				value = parseValue(value, resolvedControl);
			}

			const confidence =
				typeof parsed?.confidence === "number"
					? parsed.confidence
					: parseFloat(String(parsed?.confidence ?? ""));
			const result: ExtractionResult = {
				field: resolvedControl.key,
				value: value ?? null,
				confidence: Number.isFinite(confidence) ? confidence : 0.5,
				reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
			};

			if (debug) {
				runtime.logger.debug(
					"[FormExtraction] Single field extraction:",
					JSON.stringify(result),
				);
			}

			return result;
		}

		return null;
	} catch (error) {
		runtime.logger.error(
			"[FormExtraction] Single field extraction failed:",
			String(error),
		);
		return null;
	}
}

// ============================================================================
// CORRECTION DETECTION
// ============================================================================

/**
 * Detect if user is correcting a previous value.
 */
export async function detectCorrection(
	runtime: IAgentRuntime,
	text: string,
	currentValues: Record<string, JsonValue>,
	controls: FormControl[],
	templateValues?: TemplateValues,
): Promise<ExtractionResult[]> {
	const resolvedControls = templateValues
		? controls.map((control) =>
				resolveControlTemplates(control, templateValues),
			)
		: controls;

	const currentValuesStr = resolvedControls
		.filter((c) => currentValues[c.key] !== undefined)
		.map((c) => `- ${c.label}: ${currentValues[c.key]}`)
		.join("\n");

	if (!currentValuesStr) {
		return [];
	}

	const prompt = `Is the user correcting any of these previously provided values?

Current values:
${currentValuesStr}

User message:
"${text}"

If they are correcting a value, extract the new value. Otherwise respond with no corrections.

Respond using TOON like this:
has_correction: true or false
corrections[N]{field,old_value,new_value,confidence}:
  field_label,previous value,corrected value,0.9

If no corrections:
has_correction: false

IMPORTANT: Your response must ONLY contain the TOON document above. No preamble or explanation.`;

	try {
		const runModel = runtime.useModel.bind(runtime);
		const response = await runModel(ModelType.TEXT_SMALL, {
			prompt,
			temperature: 0.1,
		});

		const parsed = parseKeyValueXml<CorrectionXmlResponse>(response);
		const hasCorrection =
			parsed?.has_correction === true || parsed?.has_correction === "true";

		if (parsed && hasCorrection && parsed.corrections) {
			const corrections: ExtractionResult[] = [];

			const correctionList = Array.isArray(parsed.corrections)
				? parsed.corrections
				: parsed.corrections.correction
					? Array.isArray(parsed.corrections.correction)
						? parsed.corrections.correction
						: [parsed.corrections.correction]
					: [];

			for (const correction of correctionList) {
				const fieldName = correction.field ? String(correction.field) : "";
				const control = resolvedControls.find(
					(c) =>
						c.label.toLowerCase() === fieldName.toLowerCase() ||
						c.key.toLowerCase() === fieldName.toLowerCase(),
				);

				if (control) {
					let value = correction.new_value;
					if (typeof value === "string") {
						value = parseValue(value, control);
					}

					const confidence =
						typeof correction.confidence === "number"
							? correction.confidence
							: parseFloat(String(correction.confidence ?? ""));
					const extraction: ExtractionResult = {
						field: control.key,
						value: value ?? null,
						confidence: Number.isFinite(confidence) ? confidence : 0.8,
						isCorrection: true,
					};
					corrections.push(extraction);
				}
			}

			return corrections;
		}

		return [];
	} catch (error) {
		runtime.logger.error(
			"[FormExtraction] Correction detection failed:",
			String(error),
		);
		return [];
	}
}
