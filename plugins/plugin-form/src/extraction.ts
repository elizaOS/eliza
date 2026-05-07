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
import { ModelType } from "@elizaos/core";
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

type ExtractionJsonField = {
  key?: string;
  value?: JsonValue;
  confidence?: string | number;
  reasoning?: string;
  is_correction?: boolean | string;
};

type ExtractionJsonResponse = {
  intent?: string;
  extractions?: ExtractionJsonField[];
};

type SingleFieldJsonResponse = {
  found?: string | boolean;
  value?: JsonValue;
  confidence?: string | number;
  reasoning?: string;
};

type CorrectionJsonField = {
  field?: string;
  old_value?: JsonValue;
  new_value?: JsonValue;
  confidence?: string | number;
};

type CorrectionJsonResponse = {
  has_correction?: string | boolean;
  corrections?: CorrectionJsonField[];
};

function parseJsonObjectResponse<T>(response: string): T | null {
  try {
    const trimmed = response.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fenced?.[1] ?? trimmed).trim();
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

function parseBoolean(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

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
  templateValues?: TemplateValues,
): Promise<IntentResult> {
  const resolvedControls = templateValues
    ? controls.map((control) =>
        resolveControlTemplates(control, templateValues),
      )
    : controls;

  // Build the extraction prompt
  // WHY detailed field descriptions: LLM needs context to extract correctly
  const visibleControls = resolvedControls.filter((c) => !c.hidden);
  const fieldsDescription = visibleControls
    .map((c) => {
      const handler = getTypeHandler(c.type);
      const typeHint = handler?.extractionPrompt || c.type;
      const hints = c.extractHints?.join(", ") || "";
      const options = c.options?.map((o) => o.value).join(", ") || "";

      return `  ${toonCell(c.key)},${toonCell(c.label)},${toonCell(typeHint)},${toonCell(c.description || typeHint)},${toonCell(hints)},${toonCell(options)}`;
    })
    .join("\n");

  // The prompt instructs LLM on what to do
  // WHY explicit intent list: Constrains LLM to known intents
  // WHY confidence scores: Enables confirmation flow for uncertain values
  const prompt = `task: form_intent_and_extraction
form:
  name: ${toonCell(form.name)}
  description: ${toonCell(form.description)}
fields[${visibleControls.length}]{key,label,type,description,hints,options}:
${fieldsDescription || "  none,none,none,none,none,none"}
user_message: ${toonCell(text)}
intent_options[12]: fill_form, submit, stash, restore, cancel, undo, skip, explain, example, progress, autofill, other
intent_meanings[12]{intent,meaning}:
  fill_form,user is providing field values
  submit,user wants to submit or finish the form
  stash,user wants to save or pause the form for later
  restore,user wants to resume a saved form
  cancel,user wants to cancel or abandon the form
  undo,user wants to undo the last change
  skip,user wants to skip the current field
  explain,user wants an explanation
  example,user wants an example value
  progress,user wants a progress update
  autofill,user wants to use saved values
  other,none of the above
rules[3]:
  choose exactly one intent
  for fill_form extract every mentioned field value
  include confidence from 0.0 to 1.0 and mark corrections
output_schema:
  intent: one intent option
  extractions[N]{key,value,confidence,reasoning,is_correction}: zero or more extracted fields
example:
intent: fill_form
extractions[2]{key,value,confidence,reasoning,is_correction}:
  name,Jane Doe,0.95,User said their name is Jane,false
  email,jane@example.com,0.9,Email mentioned in message,false

response_rules[1]:
  return only the TOON output document`;

  try {
    // Use TEXT_SMALL for faster extraction
    // WHY low temperature: Want deterministic, consistent extraction
    const runModel = runtime.useModel.bind(runtime);
    const response = await runModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.1,
    });

    // Parse the TOON response
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
 * Parse the structured extraction response (TOON).
 *
 * WHY structured parsing:
 * - Structured output is easier to parse than free text
 * - elizaOS parseToonKeyValue handles TOON natively
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
    // Try to parse as structured output (TOON)
    const parsed = parseToonKeyValue<ExtractionToonResponse>(response);

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

        const seen = new Set<string>();
        for (const field of fields) {
          if (field?.key) {
            const dedupeKey = `${field.key}\0${String(field.value ?? "")}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const extraction: ExtractionResult = {
              field: String(field.key),
              value: field.value ?? null,
              confidence: parseFloat(String(field.confidence ?? "")) || 0.5,
              reasoning: field.reasoning ? String(field.reasoning) : undefined,
              isCorrection: toonBoolean(field.is_correction),
            };
            result.extractions.push(extraction);
          }
        }
      }
    }
  } catch (_error) {
    return result;
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
  templateValues?: TemplateValues,
): Promise<ExtractionResult | null> {
  const resolvedControl = templateValues
    ? resolveControlTemplates(control, templateValues)
    : control;
  const handler = getTypeHandler(resolvedControl.type);
  const typeHint = handler?.extractionPrompt || resolvedControl.type;

  // Focused prompt for single field extraction
  const prompt = `task: extract_single_form_field
field:
  key: ${toonCell(resolvedControl.key)}
  label: ${toonCell(resolvedControl.label)}
  type: ${toonCell(typeHint)}
  description: ${toonCell(resolvedControl.description)}
  hints: ${toonCell(resolvedControl.extractHints?.join("; "))}
  options: ${toonCell(resolvedControl.options?.map((o) => o.value).join("; "))}
  example: ${toonCell(resolvedControl.example)}
user_message: ${toonCell(text)}
output_schema:
  found: true or false
  value: extracted value or empty if not found
  confidence: 0.0 to 1.0
  reasoning: brief explanation
response_rules[1]:
  return only the TOON output document`;

  try {
    const runModel = runtime.useModel.bind(runtime);
    const response = await runModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.1,
    });

    const parsed = parseToonKeyValue<SingleFieldToonResponse>(response);

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
  templateValues?: TemplateValues,
): Promise<ExtractionResult[]> {
  const resolvedControls = templateValues
    ? controls.map((control) =>
        resolveControlTemplates(control, templateValues),
      )
    : controls;

  // Build context of current values
  const currentValueEntries = resolvedControls.filter(
    (c) => currentValues[c.key] !== undefined,
  );
  const currentValueRows = currentValueEntries
    .map(
      (c) =>
        `  ${toonCell(c.key)},${toonCell(c.label)},${toonCell(currentValues[c.key])}`,
    )
    .join("\n");

  // If nothing to correct, return early
  if (!currentValueRows) {
    return [];
  }

  const prompt = `task: detect_form_value_corrections
current_values[${currentValueEntries.length}]{key,label,value}:
${currentValueRows}
user_message: ${toonCell(text)}
rules[2]:
  decide whether the user is correcting a previous value
  when correcting extract the replacement value
output_schema:
  has_correction: true or false
  corrections[N]{field,old_value,new_value,confidence}: zero or more corrections
example:
has_correction: true
corrections[1]{field,old_value,new_value,confidence}:
  email,old@example.com,new@example.com,0.9
response_rules[1]:
  return only the TOON output document`;

  try {
    const runModel = runtime.useModel.bind(runtime);
    const response = await runModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.1,
    });

    const parsed = parseToonKeyValue<CorrectionToonResponse>(response);
    const hasCorrection =
      parsed?.has_correction === true || parsed?.has_correction === "true";

    if (parsed && hasCorrection && parsed.corrections) {
      const corrections: ExtractionResult[] = [];

      // Handle the structured TOON shapes used by older and newer prompts.
      const correctionList = Array.isArray(parsed.corrections)
        ? parsed.corrections
        : parsed.corrections.correction
          ? Array.isArray(parsed.corrections.correction)
            ? parsed.corrections.correction
            : [parsed.corrections.correction]
          : [];

      const seen = new Set<string>();
      for (const correction of correctionList) {
        // Find the control by label (LLM might use label not key)
        // WHY label matching: User sees labels, LLM extracts what user sees
        const fieldName = correction.field ? String(correction.field) : "";
        const control = resolvedControls.find(
          (c) =>
            c.label.toLowerCase() === fieldName.toLowerCase() ||
            c.key.toLowerCase() === fieldName.toLowerCase(),
        );

        if (control) {
          const dedupeKey = `${control.key}\0${String(correction.new_value ?? "")}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

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
