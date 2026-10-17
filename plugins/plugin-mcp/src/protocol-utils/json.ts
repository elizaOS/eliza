/**
 * JSON helpers for parsing and validating model-produced tool/resource
 * selections: parseJSON strips code fences and surrounding prose then parses with
 * JSON5 leniency, and validateJsonSchema gates a value against a JSON Schema via
 * Ajv. Used on the untrusted-model-output boundary in the selection flow.
 *
 * MCP tool `inputSchema` is attacker-controlled. A byte, depth, and node budget
 * limits compile work and the tool-compatibility rewrite; each schema then uses
 * an isolated Ajv so untrusted `$id` values cannot poison process-wide state.
 * Compile and evaluation failures are translated to an invalid-schema result
 * at this boundary.
 */
import Ajv from "ajv";
import JSON5 from "json5";
import { getMcpJsonSchemaBudgetError } from "./schema-budget.js";

export {
  assertMcpJsonSchemaBudget,
  getMcpJsonSchemaBudgetError,
  MAX_MCP_SCHEMA_DEPTH,
  MAX_MCP_SCHEMA_JSON_BYTES,
  MAX_MCP_SCHEMA_NODES,
  MCP_TOOL_SCHEMA_UNBOUNDED,
} from "./schema-budget.js";

interface ObjectSpan {
  readonly start: number;
  readonly end: number;
}

/** Balanced top-level `{...}` regions of `text`, oldest first, in one pass. A
 * brace in a JSON5 string or comment does not change the depth, and a nested
 * object is part of the region that holds it. Quotes and comments count only
 * inside a region: outside one the text is prose, where an apostrophe such as
 * "Here's" would open a string that pairs with a quote in a later region. */
function topLevelObjects(text: string): ObjectSpan[] {
  const spans: ObjectSpan[] = [];
  const open: number[] = [];
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (open.length === 0) {
      if (character === "{") open.push(index);
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      if (newline === -1) break;
      index = newline;
    } else if (character === "/" && text[index + 1] === "*") {
      const commentEnd = text.indexOf("*/", index + 2);
      if (commentEnd === -1) break;
      index = commentEnd + 1;
    } else if (character === "{") open.push(index);
    else if (character === "}") {
      const start = open.pop();
      // A `}` written in prose has no opening brace of its own.
      if (start !== undefined && open.length === 0) spans.push({ start, end: index + 1 });
    }
  }
  return spans;
}

/** Scan starts to try in one reply. */
const MAX_OBJECT_CANDIDATES = 64;

export function parseJSON<T>(input: string): T {
  const cleanedInput = input.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  const firstBrace = cleanedInput.indexOf("{");
  const lastBrace = cleanedInput.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No valid JSON object found in input");
  }

  const wholeRange = cleanedInput.substring(firstBrace, lastBrace + 1);
  const objects = topLevelObjects(cleanedInput).slice(-MAX_OBJECT_CANDIDATES);

  // The whole first-brace..last-brace range is tried first, so every reply that
  // parsed before parses the same way.
  let failure: string | undefined;
  try {
    return JSON5.parse(wholeRange) as T;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  // Prose around the arguments can contain a brace, as in "set units with
  // {metric} or {imperial}". The arguments follow that prose, so the newest
  // top-level region that parses is the call; the first region would run the
  // example from the sentence and skip the retry that a parse failure causes.
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const { start, end } = objects[index];
    const candidate = cleanedInput.slice(start, end);
    if (candidate === wholeRange) continue;
    try {
      return JSON5.parse(candidate) as T;
    } catch {
      // error-policy:J3 untrusted model output — try the next region.
    }
  }

  throw new Error(
    failure
      ? `No valid JSON object found in input: ${failure}`
      : "No valid JSON object found in input"
  );
}

interface AjvErrorLike {
  readonly instancePath?: string;
  readonly dataPath?: string;
  readonly message?: string;
}

function formatAjvErrors(errors: readonly AjvErrorLike[]): string {
  return errors
    .map((err) => {
      const errorPath = err.instancePath ?? err.dataPath ?? "";
      const path = errorPath ? errorPath.replace(/^\//, "") : "value";
      return `${path}: ${err.message ?? "validation failed"}`;
    })
    .join(", ");
}

export function validateJsonSchema<T>(
  data: unknown,
  schema: Readonly<Record<string, unknown>>
): { success: true; data: T } | { success: false; error: string } {
  const budgetError = getMcpJsonSchemaBudgetError(schema);
  if (budgetError) {
    return { success: false, error: budgetError };
  }

  try {
    const isolated = new Ajv({ allErrors: true });
    const validate = isolated.compile(schema);
    const valid = validate(data);

    if (!valid) {
      const errors = validate.errors ?? [];
      const errorMessage = formatAjvErrors(errors);
      return { success: false, error: errorMessage };
    }

    return { success: true, data: data as T };
  } catch (error) {
    // error-policy:J3 Ajv compile/evaluation of untrusted input must not 500 the loop
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `schema validation failed: ${message}` };
  }
}

export function stringifyJSON(value: unknown): string {
  return JSON.stringify(value);
}

export function assertJsonObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: Expected a JSON object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

export function parseStructuredModelOutput<T = Record<string, unknown>>(input: string): T {
  const errors: string[] = [];

  try {
    return parseJSON<T>(input);
  } catch {
    // error-policy:J3 untrusted model output — accumulate the parse failure and
    // rethrow a typed error below; never returns a fabricated object.
    errors.push("JSON object parse failed");
  }

  throw new Error(`No valid JSON object found: ${errors.join("; ")}`);
}
