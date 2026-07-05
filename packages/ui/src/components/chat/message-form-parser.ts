/**
 * Parser for `[FORM]\n{...json...}\n[/FORM]` blocks emitted by agent actions.
 * Lives in its own module (mirroring `message-choice-parser.ts`) so unit tests
 * can exercise the schema parsing without the `MessageContent` React graph.
 *
 * A generic in-chat form, distinct from the secret form (`SensitiveRequestBlock`,
 * driven by `message.secretRequest`). The body is a small JSON schema describing
 * the fields; `FormRequest` renders them with the config-ui control primitives +
 * the shared `runValidation` runner (the same building blocks `UiRenderer` uses),
 * so the form path is reused rather than duplicated.
 *
 * Body shape:
 *   {
 *     "id"?: string,                    // stable id; generated if omitted
 *     "title"?: string,
 *     "description"?: string,
 *     "submitLabel"?: string,           // default "Submit"
 *     "fields": [
 *       {
 *         "name": string,               // result key (required, safe chars only)
 *         "type": "text"|"number"|"select"|"checkbox",
 *         "label"?: string,
 *         "placeholder"?: string,
 *         "required"?: boolean,
 *         "options"?: [{ "label": string, "value": string }]  // select only
 *       }
 *     ]
 *   }
 *
 * On submit `FormRequest` reports `{ formId, values }` to the host, which sends
 * the structured result back as a message via the existing action callback.
 */

// Temporal types render native `<input type="date|time|datetime-local">`, which
// submit an ISO-ish string (`YYYY-MM-DD` / `HH:mm` / `YYYY-MM-DDTHH:mm`). Kept
// in sync with the core `InteractionFieldType` union; both parsers coerce any
// unknown type to `text` so a client on an older type set degrades safely.
export type FormFieldType =
  | "text"
  | "number"
  | "select"
  | "checkbox"
  | "date"
  | "time"
  | "datetime";

export interface FormFieldSpec {
  name: string;
  type: FormFieldType;
  label?: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface FormRequestSpec {
  id: string;
  title?: string;
  description?: string;
  submitLabel: string;
  fields: FormFieldSpec[];
}

/** Hard cap so a runaway agent can't render an unbounded form. */
export const MAX_FORM_FIELDS = 20;

const FORM_FIELD_TYPES = new Set<FormFieldType>([
  "text",
  "number",
  "select",
  "checkbox",
  "date",
  "time",
  "datetime",
]);

/** Field names become state-path segments + result keys; keep them safe. */
const SAFE_FIELD_NAME_RE = /^[A-Za-z][\w-]*$/;

export const FORM_RE = /\[FORM\]\n([\s\S]*?)\n\[\/FORM\]/g;

export function generateFormId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `form-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function parseField(raw: unknown): FormFieldSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || !SAFE_FIELD_NAME_RE.test(name)) return null;
  const type =
    typeof record.type === "string" &&
    FORM_FIELD_TYPES.has(record.type as FormFieldType)
      ? (record.type as FormFieldType)
      : "text";

  const field: FormFieldSpec = { name, type };
  if (typeof record.label === "string") field.label = record.label;
  if (typeof record.placeholder === "string")
    field.placeholder = record.placeholder;
  if (record.required === true) field.required = true;

  if (type === "select" && Array.isArray(record.options)) {
    const options: Array<{ label: string; value: string }> = [];
    for (const opt of record.options) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, unknown>;
      if (typeof o.value !== "string") continue;
      options.push({
        value: o.value,
        label: typeof o.label === "string" ? o.label : o.value,
      });
    }
    field.options = options;
  }

  return field;
}

/** Parse a `[FORM]` body into a normalized spec, or `null` if malformed. */
export function parseFormBody(body: string): FormRequestSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // error-policy:J3 untrusted model output — null is the explicit
    // "malformed form" signal (the block renders as plain text)
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.fields)) return null;

  const fields: FormFieldSpec[] = [];
  for (const rawField of record.fields) {
    if (fields.length >= MAX_FORM_FIELDS) break;
    const field = parseField(rawField);
    // Skip duplicate names; the first wins.
    if (field && !fields.some((f) => f.name === field.name)) {
      fields.push(field);
    }
  }
  if (fields.length === 0) return null;

  return {
    id:
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : generateFormId(),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    submitLabel:
      typeof record.submitLabel === "string" && record.submitLabel.length > 0
        ? record.submitLabel
        : "Submit",
    fields,
  };
}

export interface FormMatch {
  start: number;
  end: number;
  form: FormRequestSpec;
}

/** Find every FORM block in `text` and return their character regions. */
export function findFormRegions(text: string): FormMatch[] {
  const results: FormMatch[] = [];
  FORM_RE.lastIndex = 0;
  let m: RegExpExecArray | null = FORM_RE.exec(text);
  while (m !== null) {
    const form = parseFormBody(m[1]);
    if (form) {
      results.push({
        start: m.index,
        end: m.index + m[0].length,
        form,
      });
    }
    m = FORM_RE.exec(text);
  }
  return results;
}
