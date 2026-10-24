/**
 * @module extraction
 * @description LLM-based field extraction from natural language.
 *
 * Exposes prompt/schema/parse helpers consumed by the form Evaluator and
 * runs the LLM call directly only for the targeted single-field and
 * correction-detection helpers.
 */

import type { IAgentRuntime, JSONSchema, JsonValue } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { FormService } from "./service";
import type { TemplateValues } from "./template";
import { resolveControlTemplates } from "./template";
import type {
  ControlType,
  ExtractionResult,
  FormControl,
  FormDefinition,
  FormIntent,
  IntentResult,
} from "./types";
import { getTypeHandler, parseValue, validateField } from "./validation";

const FORM_INTENTS: FormIntent[] = [
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

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const INTENT_MEANINGS: Record<FormIntent, string> = {
  fill_form: "user is providing field values",
  submit: "user wants to submit or finish the form",
  stash: "user wants to save or pause the form for later",
  restore: "user wants to resume a saved form",
  cancel: "user wants to cancel or abandon the form",
  undo: "user wants to undo the last change",
  skip: "user wants to skip the current field",
  explain: "user wants an explanation",
  example: "user wants an example value",
  progress: "user wants a progress update",
  autofill: "user wants to use saved values",
  other: "none of the above",
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

interface JsonObjectRegion {
  start: number;
  end: number;
}

/**
 * Find each complete top-level `{...}` region in one pass. A brace inside a
 * JSON string does not change the depth, so a value such as `"a{b}c"` stays
 * inside its region. A region still open at the end of the text is a cut-off
 * reply and is not reported.
 */
function topLevelObjectRegions(text: string): JsonObjectRegion[] {
  const regions: JsonObjectRegion[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) regions.push({ start, end: index + 1 });
    }
  }
  return regions;
}

/** Fields that carry the answer, at the top level or inside `corrections`. */
const ANSWER_VALUE_FIELDS = new Set(["value", "old_value", "new_value"]);

function valueFieldStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || !value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((entry) => valueFieldStrings(entry, depth + 1));
  const strings: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && ANSWER_VALUE_FIELDS.has(key)) {
      strings.push(entry.trim());
    } else if (entry && typeof entry === "object") {
      strings.push(...valueFieldStrings(entry, depth + 1));
    }
  }
  return strings;
}

/**
 * The placeholder text each prompt shows as its own response shape. A reply can
 * restate the shape it was given, and a restated shape is not an answer: it
 * carries the placeholder, not the user's value. Only the placeholder of the
 * caller's own prompt marks an echo, so a real answer that equals example text
 * from another prompt stays an answer.
 */
const SINGLE_FIELD_SHAPE_VALUE = "extracted value or null if not found";
const CORRECTION_SHAPE_OLD_VALUE = "old@example.com";
const CORRECTION_SHAPE_NEW_VALUE = "new@example.com";

function sameText(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === expected;
}

/** The user's own words carry this text, so the text is data and not a shape. */
function userSupplied(userText: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const said = userText.toLowerCase();
  const needle = value.trim().toLowerCase();
  return needle.length > 0 && said.includes(needle);
}

/** Every answer value repeats the single-field placeholder value. */
function isSingleFieldShapeEcho(
  parsed: SingleFieldJsonResponse,
  userText: string,
): boolean {
  const strings = valueFieldStrings(parsed);
  return (
    strings.length > 0 &&
    strings.every(
      (entry) =>
        sameText(entry, SINGLE_FIELD_SHAPE_VALUE) &&
        !userSupplied(userText, entry),
    )
  );
}

/** The stored value of the field a correction names, when the form has it. */
function currentValueOfCorrectionField(
  field: unknown,
  controls: FormControl[],
  currentValues: Record<string, JsonValue>,
): JsonValue | undefined {
  if (typeof field !== "string") return undefined;
  const name = field.trim().toLowerCase();
  if (!name) return undefined;
  // Same resolution rule the caller uses to write the correction: a label or a
  // key, case-insensitive. A name that matches no control grounds nothing.
  const control = controls.find(
    (c) => c.label.toLowerCase() === name || c.key.toLowerCase() === name,
  );
  return control ? currentValues[control.key] : undefined;
}

/**
 * Every correction repeats the correction prompt's example pair. The user's own
 * message and the value the form already holds win: a pair is a real correction
 * only when the user stated the replacement and the old address is either
 * their own words or the exact stored value of the field being corrected. A
 * mention of one side does not ground the other side, and a value stored on a
 * different field does not authorize this one, so restating the pair stays a
 * shape echo.
 */
function isCorrectionShapeEcho(
  parsed: CorrectionJsonResponse,
  userText: string,
  currentValues: Record<string, JsonValue>,
  controls: FormControl[],
): boolean {
  const corrections = Array.isArray(parsed?.corrections)
    ? parsed.corrections
    : [];
  if (corrections.length === 0) return false;
  return corrections.every((correction) => {
    if (!sameText(correction.old_value, CORRECTION_SHAPE_OLD_VALUE))
      return false;
    if (!sameText(correction.new_value, CORRECTION_SHAPE_NEW_VALUE))
      return false;
    if (!userSupplied(userText, correction.new_value)) return true;
    if (userSupplied(userText, correction.old_value)) return false;
    // An exact normalized match with this field's own value, not a substring
    // of any stored value and not a value that belongs to another field.
    const stored = currentValueOfCorrectionField(
      correction.field,
      controls,
      currentValues,
    );
    return !(
      typeof stored === "string" && sameText(stored, CORRECTION_SHAPE_OLD_VALUE)
    );
  });
}

function parseJsonObjectResponse<T>(
  response: string,
  isShapeEcho: (parsed: T) => boolean,
): T | null {
  const acrossRegions = (candidate: string): T | null => {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as T;
    } catch {
      return null;
    }
  };
  const trimmed = String(response ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const regions = topLevelObjectRegions(candidate);
  // Prose can hold its own complete braces, as in "treat {city} as text", and
  // the reply can narrate before or after the object. Read the newest region
  // that the caller does not report as its own restated shape: an answer stays
  // readable when the shape is restated after it, and a cut-off reply that only
  // restated the shape keeps the field empty instead of storing placeholder text.
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index];
    const parsed = acrossRegions(candidate.slice(region.start, region.end));
    if (parsed && !isShapeEcho(parsed)) return parsed;
  }
  return null;
}

function parseBoolean(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dedupe key for an extracted or corrected field value. Values are compared by
 * their JSON encoding so distinct object/array values (which all stringify to
 * "[object Object]" via `String()`) are kept apart.
 */
function extractionDedupeKey(field: string, value: unknown): string {
  return `${field}\0${JSON.stringify(value ?? null)}`;
}

function isValidIntent(str: string): str is FormIntent {
  return (FORM_INTENTS as string[]).includes(str);
}

function isSafeExtractionField(field: string): boolean {
  return field
    .split(".")
    .every((part) => part.length > 0 && !UNSAFE_OBJECT_KEYS.has(part));
}

// ============================================================================
// EVALUATOR HELPERS — schema, prompt, parse for the evaluator pass
// ============================================================================

/**
 * Build the JSON Schema fragment for the form-extractor evaluator section.
 *
 * Returned shape:
 *   { formIntent: <enum>, formExtractions: [{ field, value, confidence, isCorrection }] }
 */
export function buildFormExtractorSchema(): JSONSchema {
  return {
    type: "object",
    properties: {
      formIntent: {
        type: "string",
        enum: [...FORM_INTENTS],
      },
      formExtractions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            value: {},
            confidence: { type: "number" },
            isCorrection: { type: "boolean" },
            reasoning: { type: "string" },
          },
          required: ["field", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["formIntent", "formExtractions"],
    additionalProperties: false,
  };
}

/**
 * Build the prompt section for the form-extractor evaluator.
 *
 * The evaluator prompt inlines this string and asks the model to
 * populate `{ formIntent, formExtractions }` for the active form.
 */
export function buildFormExtractorPromptSection(params: {
  text: string;
  form: FormDefinition;
  controls: FormControl[];
  templateValues?: TemplateValues;
  resolveControlType?: (typeId: string) => ControlType | undefined;
}): string {
  const { text, form, controls, templateValues, resolveControlType } = params;

  const resolvedControls = templateValues
    ? controls.map((control) =>
        resolveControlTemplates(control, templateValues),
      )
    : controls;

  const visibleControls = resolvedControls.filter((c) => !c.hidden);
  const fieldsDescription = visibleControls.map((c) => {
    const handler = getTypeHandler(c.type, resolveControlType?.(c.type));
    const typeHint = handler?.extractionPrompt || c.type;
    return {
      key: c.key,
      label: c.label,
      type: typeHint,
      description: c.description || typeHint,
      hints: c.extractHints ?? [],
      options: c.options?.map((o) => o.value) ?? [],
    };
  });

  return `Extract active form intent + field values.

Context JSON:
${JSON.stringify(
  {
    form: {
      name: form.name,
      description: form.description,
    },
    fields: fieldsDescription,
    user_message: text,
    intent_options: FORM_INTENTS,
    intent_meanings: INTENT_MEANINGS,
  },
  null,
  2,
)}

Return:
{
  "formIntent": "one of intent_options",
  "formExtractions": [
    { "field": "<key>", "value": <extracted>, "confidence": 0.0-1.0, "isCorrection": false, "reasoning": "brief" }
  ]
}

Rules:
- Choose exactly one intent.
- fill_form: extract every mentioned field value.
- No fields -> formExtractions=[].
- confidence 0.0-1.0.`;
}

/**
 * Parse the raw `{ formIntent, formExtractions }` object produced by the
 * evaluator pass into a typed `IntentResult`. Type coercion and
 * validation against control rules happen later (in the processor) where
 * the form definition is in scope.
 */
export function parseFormExtractorOutput(raw: unknown): IntentResult | null {
  if (!isRecord(raw)) return null;

  const intentStr =
    typeof raw.formIntent === "string" ? raw.formIntent.toLowerCase() : "other";
  const intent: FormIntent = isValidIntent(intentStr) ? intentStr : "other";

  const rawExtractions = Array.isArray(raw.formExtractions)
    ? raw.formExtractions
    : [];

  const extractions: ExtractionResult[] = [];
  const seen = new Set<string>();

  for (const entry of rawExtractions) {
    if (!isRecord(entry)) continue;
    const fieldKey = typeof entry.field === "string" ? entry.field : "";
    if (!fieldKey) continue;
    if (!isSafeExtractionField(fieldKey)) continue;

    const dedupeKey = extractionDedupeKey(fieldKey, entry.value);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const value: JsonValue = (entry.value as JsonValue | undefined) ?? null;

    let confidence =
      typeof entry.confidence === "number"
        ? entry.confidence
        : parseFloat(String(entry.confidence ?? ""));
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));

    const reasoning =
      typeof entry.reasoning === "string" ? entry.reasoning : undefined;

    extractions.push({
      field: fieldKey,
      value,
      confidence,
      reasoning,
      isCorrection: parseBoolean(entry.isCorrection),
    });
  }

  return { intent, extractions };
}

/**
 * Apply type coercion + validation to a parsed extractions list against the
 * resolved form controls. Lowers confidence to 0.3 when a value fails the
 * control's validator (so downstream confirmation flow kicks in).
 */
export function coerceExtractionsAgainstControls(
  extractions: ExtractionResult[],
  controls: FormControl[],
  templateValues?: TemplateValues,
  resolveControlType?: (typeId: string) => ControlType | undefined,
): ExtractionResult[] {
  const resolvedControls = templateValues
    ? controls.map((control) =>
        resolveControlTemplates(control, templateValues),
      )
    : controls;

  const controlsByKey = new Map(
    resolvedControls.map((control) => [control.key, control]),
  );

  return extractions.flatMap((extraction) => {
    if (extraction.field.includes(".")) {
      const [parentKey, subKey, ...extraParts] = extraction.field.split(".");
      if (extraParts.length > 0 || !parentKey || !subKey) return [];
      if (!controlsByKey.has(parentKey)) return [];
      return [extraction];
    }

    const control = controlsByKey.get(extraction.field);
    if (!control) return [];
    const controlType = resolveControlType?.(control.type);

    let value = extraction.value;
    if (typeof value === "string") {
      value = parseValue(value, control, controlType);
    }

    const validation = validateField(value, control, controlType);
    if (!validation.valid) {
      const reasoning =
        `${extraction.reasoning ?? ""} (Validation failed: ${validation.error})`.trim();
      return [
        {
          ...extraction,
          value,
          confidence: Math.min(extraction.confidence, 0.3),
          reasoning,
        },
      ];
    }

    return [{ ...extraction, value }];
  });
}

// ============================================================================
// SINGLE-FIELD EXTRACTION (still owns its LLM call — narrow targeted use)
// ============================================================================

/**
 * Extract a specific field value from a user message with a focused prompt.
 *
 * Used when the agent has just asked for a specific field and expects a
 * direct answer. Independent of the evaluator pass.
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
  const formService = runtime.getService("FORM");
  const controlType =
    formService instanceof FormService
      ? formService.getControlType(resolvedControl.type)
      : undefined;
  const handler = getTypeHandler(resolvedControl.type, controlType);
  const typeHint = handler?.extractionPrompt || resolvedControl.type;

  const prompt = `Extract a single form field value from the user message.

Context JSON:
${JSON.stringify(
  {
    field: {
      key: resolvedControl.key,
      label: resolvedControl.label,
      type: typeHint,
      description: resolvedControl.description,
      hints: resolvedControl.extractHints ?? [],
      options: resolvedControl.options?.map((o) => o.value) ?? [],
      example: resolvedControl.example,
    },
    user_message: text,
  },
  null,
  2,
)}

Return only a valid JSON object with this schema:
{
  "found": true,
  "value": "extracted value or null if not found",
  "confidence": 0.95,
  "reasoning": "brief explanation"
}`;

  const runModel = runtime.useModel.bind(runtime);
  const response = await runModel(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.1,
  });

  const parsed = parseJsonObjectResponse<SingleFieldJsonResponse>(
    response,
    (parsed) => isSingleFieldShapeEcho(parsed, text),
  );
  const found = parsed?.found === true || parsed?.found === "true";
  if (!found || !parsed) return null;

  let value = parsed.value;
  if (typeof value === "string") {
    value = parseValue(value, resolvedControl, controlType);
  }

  const confidence =
    typeof parsed.confidence === "number"
      ? parsed.confidence
      : parseFloat(String(parsed.confidence ?? ""));

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

// ============================================================================
// CORRECTION DETECTION (still owns its LLM call — narrow targeted use)
// ============================================================================

/**
 * Detect whether the user is correcting a previously filled value.
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

  const currentValueEntries = resolvedControls.filter(
    (c) => currentValues[c.key] !== undefined,
  );
  if (currentValueEntries.length === 0) return [];

  const currentValueRows = currentValueEntries.map((c) => ({
    key: c.key,
    label: c.label,
    value: currentValues[c.key],
  }));

  const prompt = `Detect whether the user is correcting a previous form value.

Context JSON:
${JSON.stringify(
  {
    current_values: currentValueRows,
    user_message: text,
  },
  null,
  2,
)}

Return only a valid JSON object with this schema:
{
  "has_correction": true,
  "corrections": [
    {
      "field": "email",
      "old_value": "old@example.com",
      "new_value": "new@example.com",
      "confidence": 0.9
    }
  ]
}

Rules:
- Decide whether the user is correcting a previous value.
- When correcting, extract the replacement value.
- Use an empty corrections array when no corrections were found.`;

  const runModel = runtime.useModel.bind(runtime);
  const response = await runModel(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.1,
  });

  const parsed = parseJsonObjectResponse<CorrectionJsonResponse>(
    response,
    (parsed) =>
      isCorrectionShapeEcho(parsed, text, currentValues, resolvedControls),
  );
  const hasCorrection =
    parsed?.has_correction === true || parsed?.has_correction === "true";
  if (!parsed || !hasCorrection || !parsed.corrections) return [];

  const formService = runtime.getService("FORM");
  const corrections: ExtractionResult[] = [];
  const correctionList = Array.isArray(parsed.corrections)
    ? parsed.corrections
    : [];
  const seen = new Set<string>();

  for (const correction of correctionList) {
    const fieldName = correction.field ? String(correction.field) : "";
    const control = resolvedControls.find(
      (c) =>
        c.label.toLowerCase() === fieldName.toLowerCase() ||
        c.key.toLowerCase() === fieldName.toLowerCase(),
    );
    if (!control) continue;

    const dedupeKey = extractionDedupeKey(control.key, correction.new_value);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let value = correction.new_value;
    if (typeof value === "string") {
      const controlType =
        formService instanceof FormService
          ? formService.getControlType(control.type)
          : undefined;
      value = parseValue(value, control, controlType);
    }

    const confidence =
      typeof correction.confidence === "number"
        ? correction.confidence
        : parseFloat(String(correction.confidence ?? ""));

    corrections.push({
      field: control.key,
      value: value ?? null,
      confidence: Number.isFinite(confidence) ? confidence : 0.8,
      isCorrection: true,
    });
  }

  return corrections;
}
