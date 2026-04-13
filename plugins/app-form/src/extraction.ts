/**
 * @module extraction
 * @description LLM-based field extraction from natural language
 *
 * ## Design Philosophy
 *
 * Unlike traditional forms where users fill in specific fields, agent-native
 * forms let users provide information naturally. The user might say:
 *
 * "I'm John, 25 years old, and my email is john@example.com"
 *
 * This module extracts: { name: "John", age: 25, email: "john@example.com" }
 *
 * ## Why LLM Extraction
 *
 * 1. **Natural Language**: Users don't think in form fields
 * 2. **Babble Support**: One message can fill multiple fields
 * 3. **Correction Handling**: "Actually, my name is Jon not John"
 * 4. **Ambiguity Resolution**: LLM can ask for clarification
 *
 * ## Extraction Flow
 *
 * 1. Build a prompt with field definitions and user message
 * 2. Ask LLM to extract values and assess confidence
 * 3. Parse LLM's structured response
 * 4. Validate extracted values against control rules
 * 5. Return results with confidence scores
 *
 * ## Confidence Scores
 *
 * Each extraction has a confidence score (0-1):
 * - 0.9-1.0: High confidence, auto-accept
 * - 0.7-0.9: Medium confidence, might auto-accept
 * - 0.5-0.7: Low confidence, ask for confirmation
 * - 0.0-0.5: Very low, probably wrong
 *
 * The threshold is configurable per-field (FormControl.confirmThreshold).
 *
 * ## Bundled Intent + Extraction
 *
 * We detect intent AND extract values in a single LLM call because:
 * - Reduces latency (one call vs two)
 * - Context helps with both tasks
 * - Intent affects what to extract
 */

import type { IAgentRuntime, JsonValue } from "@elizaos/core";
import { ModelType, parseKeyValueXml } from "@elizaos/core";
import type { TemplateValues } from "./template";
import { resolveControlTemplates } from "./template";
import type {
  ExtractionResult,
  FormControl,
  FormDefinition,
  FormIntent,
  IntentResult,
} from "./types";
import { getTypeHandler, parseValue, validateField } from "./validation";

type ExtractionXmlField = {
  key?: string;
  value?: JsonValue;
  confidence?: string | number;
  reasoning?: string;
  is_correction?: boolean | string;
};

type ExtractionXmlResponse = {
  intent?: string;
  extractions?: { field?: ExtractionXmlField | ExtractionXmlField[] } | ExtractionXmlField[];
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
  corrections?: { correction?: CorrectionXmlField | CorrectionXmlField[] } | CorrectionXmlField[];
};

// ============================================================================
// LLM-BASED EXTRACTION
// ============================================================================

/**
 * Extract field values and detect intent from user message using LLM.
 *
 * This is the main extraction function called by the evaluator.
 * It combines intent detection with field extraction in a single call.
 *
 * WHY single call:
 * - LLM calls are expensive (latency and cost)
 * - Intent and extraction share context
 * - More accurate when done together
 *
 * @param runtime - Agent runtime for model access
 * @param text - User message text
 * @param form - Form definition for context
 * @param controls - Fields to extract
 * @returns Intent result with extractions
 */
export async function llmIntentAndExtract(
  runtime: IAgentRuntime,
  text: string,
  form: FormDefinition,
  controls: FormControl[],
  templateValues?: TemplateValues
): Promise<IntentResult> {
  const resolvedControls = templateValues
    ? controls.map((control) => resolveControlTemplates(control, templateValues))
    : controls;

  // Build the extraction prompt
  // WHY detailed field descriptions: LLM needs context to extract correctly
  const fieldsDescription = resolvedControls
    .filter((c) => !c.hidden) // Hidden fields are extracted silently
    .map((c) => {
      const handler = getTypeHandler(c.type);
      const typeHint = handler?.extractionPrompt || c.type;
      const hints = c.extractHints?.join(", ") || "";
      const options = c.options?.map((o) => o.value).join(", ") || "";

      // Build a rich field description for the LLM
      return `- ${c.key} (${c.label}): ${c.description || typeHint}${hints ? ` [hints: ${hints}]` : ""}${options ? ` [options: ${options}]` : ""}`;
    })
    .join("\n");

  // The prompt instructs LLM on what to do
  // WHY explicit intent list: Constrains LLM to known intents
  // WHY confidence scores: Enables confirmation flow for uncertain values
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
    // Use TEXT_SMALL for faster extraction
    // WHY low temperature: Want deterministic, consistent extraction
    const runModel = runtime.useModel.bind(runtime);
    const response = await runModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.1,
    });

    // Parse the XML response
    const parsed = parseExtractionResponse(response);

    // Validate and parse extracted values
    // WHY post-validation: LLM might extract invalid values
    for (const extraction of parsed.extractions) {
      const control = resolvedControls.find((c) => c.key === extraction.field);
      if (control) {
        // Parse the value to the correct type
        if (typeof extraction.value === "string") {
          extraction.value = parseValue(extraction.value, control);
        }

        // Validate the extracted value
        const validation = validateField(extraction.value, control);
        if (!validation.valid) {
          // Reduce confidence for invalid values
          // WHY: Low confidence triggers re-ask, not auto-accept
          extraction.confidence = Math.min(extraction.confidence, 0.3);
          extraction.reasoning = `${extraction.reasoning || ""} (Validation failed: ${validation.error})`;
        }
      }
    }

    // Log if debug mode
    if (form.debug) {
      runtime.logger.debug("[FormExtraction] LLM extraction result:", JSON.stringify(parsed));
    }

    return parsed;
  } catch (error) {
    runtime.logger.error("[FormExtraction] LLM extraction failed:", String(error));
    return { intent: "other", extractions: [] };
  }
}

/**
 * Parse the structured extraction response (TOON-first, XML fallback).
 *
 * WHY structured parsing:
 * - Structured output is easier to parse than free text
 * - elizaOS parseKeyValueXml handles TOON natively, falls back to XML
 * - Falls back to regex if both fail
 *
 * @param response - LLM's structured response string
 * @returns Parsed intent and extractions
 */
function parseExtractionResponse(response: string): IntentResult {
  const result: IntentResult = {
    intent: "other",
    extractions: [],
  };

  try {
    // Try to parse as structured output (TOON-first, XML fallback)
    const parsed = parseKeyValueXml<ExtractionXmlResponse>(response);

    if (parsed) {
      // Get intent
      const intentStr = parsed.intent?.toLowerCase() ?? "other";
      result.intent = isValidIntent(intentStr) ? intentStr : "other";

      // Get extractions - handle various structured output formats
      // WHY flexible parsing: LLM might format arrays differently
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
              isCorrection: field.is_correction === "true" || field.is_correction === true,
            };
            result.extractions.push(extraction);
          }
        }
      }
    }
  } catch (_error) {
    // Fallback: try regex extraction
    // WHY fallback: LLM might produce slightly malformed XML
    const intentMatch = response.match(/<intent>([^<]+)<\/intent>/);
    if (intentMatch) {
      const intentStr = intentMatch[1].toLowerCase().trim();
      result.intent = isValidIntent(intentStr) ? intentStr : "other";
    }

    // Extract fields with regex as fallback
    const fieldMatches = response.matchAll(
      /<field>\s*<key>([^<]+)<\/key>\s*<value>([^<]*)<\/value>\s*<confidence>([^<]+)<\/confidence>/g
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

/**
 * Check if string is a valid intent.
 *
 * WHY type guard:
 * - TypeScript can't know LLM output is valid
 * - Ensures only known intents are used
 * - Fallback to 'other' for unknown
 */
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
 *
 * Used when asking for a specific field and expecting direct answer.
 * Simpler prompt than full intent+extraction.
 *
 * WHY separate function:
 * - When context is clear, full extraction is overkill
 * - "What's your email?" -> "john@example.com" is simple
 * - Faster, more focused extraction
 *
 * @param runtime - Agent runtime for model access
 * @param text - User message text
 * @param control - The field to extract
 * @param debug - Enable debug logging
 * @returns Extraction result or null if not found
 */
export async function extractSingleField(
  runtime: IAgentRuntime,
  text: string,
  control: FormControl,
  debug?: boolean,
  templateValues?: TemplateValues
): Promise<ExtractionResult | null> {
  const resolvedControl = templateValues
    ? resolveControlTemplates(control, templateValues)
    : control;
  const handler = getTypeHandler(resolvedControl.type);
  const typeHint = handler?.extractionPrompt || resolvedControl.type;

  // Focused prompt for single field extraction
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

      // Parse value to correct type
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
        runtime.logger.debug("[FormExtraction] Single field extraction:", JSON.stringify(result));
      }

      return result;
    }

    return null;
  } catch (error) {
    runtime.logger.error("[FormExtraction] Single field extraction failed:", String(error));
    return null;
  }
}

// ============================================================================
// CORRECTION DETECTION
// ============================================================================

/**
 * Detect if user is correcting a previous value.
 *
 * Looks for patterns like:
 * - "Actually, my name is Jon not John"
 * - "Sorry, I meant jon@gmail.com"
 * - "Change my age to 26"
 *
 * WHY separate from main extraction:
 * - Correction detection needs current values as context
 * - More focused prompt for better accuracy
 * - Can be skipped if no values exist
 *
 * @param runtime - Agent runtime for model access
 * @param text - User message text
 * @param currentValues - Currently filled values
 * @param controls - Field definitions
 * @returns Array of corrections (empty if no corrections)
 */
export async function detectCorrection(
  runtime: IAgentRuntime,
  text: string,
  currentValues: Record<string, JsonValue>,
  controls: FormControl[],
  templateValues?: TemplateValues
): Promise<ExtractionResult[]> {
  const resolvedControls = templateValues
    ? controls.map((control) => resolveControlTemplates(control, templateValues))
    : controls;

  // Build context of current values
  const currentValuesStr = resolvedControls
    .filter((c) => currentValues[c.key] !== undefined)
    .map((c) => `- ${c.label}: ${currentValues[c.key]}`)
    .join("\n");

  // If nothing to correct, return early
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
    const hasCorrection = parsed?.has_correction === true || parsed?.has_correction === "true";

    if (parsed && hasCorrection && parsed.corrections) {
      const corrections: ExtractionResult[] = [];

      // Handle various XML structures
      const correctionList = Array.isArray(parsed.corrections)
        ? parsed.corrections
        : parsed.corrections.correction
          ? Array.isArray(parsed.corrections.correction)
            ? parsed.corrections.correction
            : [parsed.corrections.correction]
          : [];

      for (const correction of correctionList) {
        // Find the control by label (LLM might use label not key)
        // WHY label matching: User sees labels, LLM extracts what user sees
        const fieldName = correction.field ? String(correction.field) : "";
        const control = resolvedControls.find(
          (c) =>
            c.label.toLowerCase() === fieldName.toLowerCase() ||
            c.key.toLowerCase() === fieldName.toLowerCase()
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
    runtime.logger.error("[FormExtraction] Correction detection failed:", String(error));
    return [];
  }
}
