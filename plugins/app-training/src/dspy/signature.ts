/**
 * DSPy-style Signature primitive (native TS).
 *
 * A `Signature` is a declarative I/O contract between a Predict module and an
 * LM: typed input fields + typed output fields + natural-language instructions.
 * The runtime renders a Signature into a system + user prompt and parses the
 * LM's response back into a typed output record.
 *
 * This is our own implementation — no ax, no dspy, no @ax-llm/ax imports.
 *
 * Render protocol (deterministic so optimizer scoring is reproducible):
 *
 *   System prompt:
 *     <instructions>
 *
 *     Input fields:
 *     - <name> (<type>): <description>
 *     ...
 *
 *     Output fields:
 *     - <name> (<type>): <description>
 *     ...
 *
 *     Respond with each output field on its own line, formatted as:
 *     <field_name>: <value>
 *
 *   User prompt:
 *     <input_name>: <value>
 *     ...
 *
 * Parse protocol: read `^<field_name>:\s*(.*)$` per line. Multiline trailing
 * content is captured up to the next field-name header so output fields with
 * multi-line `reasoning` strings round-trip correctly.
 */

export type FieldType = "string" | "number" | "boolean" | "enum";

export interface FieldSpec {
  name: string;
  description: string;
  type: FieldType;
  enumValues?: readonly string[];
  optional?: boolean;
}

export interface SignatureSpec {
  name: string;
  instructions: string;
  inputs: ReadonlyArray<FieldSpec>;
  outputs: ReadonlyArray<FieldSpec>;
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

export class SignatureParseError extends Error {
  constructor(
    message: string,
    readonly fieldName?: string,
  ) {
    super(message);
    this.name = "SignatureParseError";
  }
}

/**
 * Strongly-typed Signature handle.
 *
 * The generic parameters carry the field-name keys so callers get
 * autocomplete on `forward()` inputs and on the parsed `output` record.
 */
export class Signature<
  I extends Record<string, unknown> = Record<string, unknown>,
  O extends Record<string, unknown> = Record<string, unknown>,
> {
  constructor(public readonly spec: SignatureSpec) {
    if (spec.inputs.length === 0) {
      throw new Error(
        `[Signature] '${spec.name}' must declare at least one input field`,
      );
    }
    if (spec.outputs.length === 0) {
      throw new Error(
        `[Signature] '${spec.name}' must declare at least one output field`,
      );
    }
    // Reject duplicate names within or across input/output sets — they would
    // confuse the parser (output field would shadow input field).
    const names = new Set<string>();
    for (const field of [...spec.inputs, ...spec.outputs]) {
      if (names.has(field.name)) {
        throw new Error(
          `[Signature] '${spec.name}' has duplicate field name '${field.name}'`,
        );
      }
      names.add(field.name);
    }
  }

  get name(): string {
    return this.spec.name;
  }

  get inputs(): ReadonlyArray<FieldSpec> {
    return this.spec.inputs;
  }

  get outputs(): ReadonlyArray<FieldSpec> {
    return this.spec.outputs;
  }

  /**
   * Render the signature to a system + user prompt. The `instructionsOverride`
   * lets COPRO/MIPRO swap in a candidate instruction string without rebuilding
   * the whole signature.
   */
  render(
    input: I,
    options?: { instructionsOverride?: string },
  ): RenderedPrompt {
    const instructions =
      options?.instructionsOverride ?? this.spec.instructions;
    const systemLines: string[] = [];
    if (instructions.trim().length > 0) {
      systemLines.push(instructions.trim());
      systemLines.push("");
    }
    systemLines.push("Input fields:");
    for (const field of this.spec.inputs) {
      systemLines.push(
        `- ${field.name} (${renderFieldType(field)}): ${field.description}`,
      );
    }
    systemLines.push("");
    systemLines.push("Output fields:");
    for (const field of this.spec.outputs) {
      systemLines.push(
        `- ${field.name} (${renderFieldType(field)}): ${field.description}`,
      );
    }
    systemLines.push("");
    systemLines.push(
      "Respond with each output field on its own line, formatted as:",
    );
    systemLines.push("<field_name>: <value>");

    const userLines: string[] = [];
    for (const field of this.spec.inputs) {
      const raw = input[field.name];
      if (raw === undefined || raw === null) {
        if (!field.optional) {
          throw new Error(
            `[Signature:${this.spec.name}] missing required input '${field.name}'`,
          );
        }
        continue;
      }
      userLines.push(`${field.name}: ${renderValue(raw)}`);
    }

    return {
      system: systemLines.join("\n"),
      user: userLines.join("\n"),
    };
  }

  /**
   * Parse an LM response into a typed output record. Multi-line field values
   * are supported — content after `<field>:` extends until the next known
   * field header or end of string.
   */
  parse(raw: string): O {
    const text = stripFences(raw);
    // Sort fields by name length descending so a field named `reasoning_full`
    // is matched before `reasoning` when both exist.
    const orderedFields = [...this.spec.outputs];
    const fieldNames = orderedFields.map((f) => f.name);
    const result: Record<string, unknown> = {};
    const fieldPositions = locateFieldHeaders(text, fieldNames);

    for (let i = 0; i < orderedFields.length; i += 1) {
      const field = orderedFields[i];
      if (!field) continue;
      const span = fieldPositions[field.name];
      if (!span) {
        if (field.optional) continue;
        throw new SignatureParseError(
          `missing required output field '${field.name}' in LM response`,
          field.name,
        );
      }
      const valueText = span.value;
      result[field.name] = coerceValue(field, valueText);
    }
    return result as O;
  }
}

function renderFieldType(field: FieldSpec): string {
  if (field.type === "enum") {
    const values = field.enumValues ?? [];
    return `enum: ${values.join(" | ")}`;
  }
  return field.type;
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

interface FieldSpan {
  value: string;
}

/**
 * Find each declared field header in the response text and return the
 * substring between this header and the next. Headers must appear at the
 * start of a line (anchored on `^` or `\n`). Unknown lines before the first
 * known header are ignored — some models emit prose preamble even when told
 * not to.
 */
function locateFieldHeaders(
  text: string,
  fieldNames: string[],
): Record<string, FieldSpan> {
  const positions: Array<{ name: string; start: number; valueStart: number }> =
    [];
  for (const name of fieldNames) {
    // Use a fresh RegExp per field — the field header anchors on a line start.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|\\n)\\s*${escaped}\\s*:\\s*`, "i");
    const match = pattern.exec(text);
    if (!match) continue;
    const start = match.index + (match[1] === "" ? 0 : match[1].length);
    const valueStart = start + (match[0].length - (match[1] ?? "").length);
    positions.push({ name, start, valueStart });
  }
  positions.sort((a, b) => a.start - b.start);

  const out: Record<string, FieldSpan> = {};
  for (let i = 0; i < positions.length; i += 1) {
    const here = positions[i];
    if (!here) continue;
    const next = positions[i + 1];
    const end = next ? next.start : text.length;
    const value = text.slice(here.valueStart, end).trimEnd();
    out[here.name] = { value };
  }
  return out;
}

function coerceValue(field: FieldSpec, raw: string): unknown {
  const trimmed = raw.trim();
  switch (field.type) {
    case "string":
      return trimmed;
    case "number": {
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        throw new SignatureParseError(
          `field '${field.name}' expected number, got '${trimmed}'`,
          field.name,
        );
      }
      return num;
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (lower === "true" || lower === "yes" || lower === "1") return true;
      if (lower === "false" || lower === "no" || lower === "0") return false;
      throw new SignatureParseError(
        `field '${field.name}' expected boolean, got '${trimmed}'`,
        field.name,
      );
    }
    case "enum": {
      const values = field.enumValues ?? [];
      const match = values.find(
        (v) => v.toLowerCase() === trimmed.toLowerCase(),
      );
      if (!match) {
        throw new SignatureParseError(
          `field '${field.name}' expected one of [${values.join(", ")}], got '${trimmed}'`,
          field.name,
        );
      }
      return match;
    }
  }
}

/**
 * Convenience constructor for signatures defined as a literal block.
 */
export function defineSignature<
  I extends Record<string, unknown> = Record<string, unknown>,
  O extends Record<string, unknown> = Record<string, unknown>,
>(spec: SignatureSpec): Signature<I, O> {
  return new Signature<I, O>(spec);
}
