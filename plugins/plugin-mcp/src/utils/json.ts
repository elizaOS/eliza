/**
 * JSON helpers for parsing and validating model-produced tool/resource
 * selections: parseJSON strips code fences and surrounding prose then parses with
 * JSON5 leniency, and validateJsonSchema gates a value against a JSON Schema via
 * Ajv. Used on the untrusted-model-output boundary in the selection flow.
 *
 * MCP tool `inputSchema` is attacker-controlled. A byte, depth, and node budget
 * limits compile work; each schema then uses an isolated Ajv so untrusted `$id`
 * values cannot poison process-wide state. Compile and evaluation failures are
 * translated to an invalid-schema result at this boundary.
 */
import Ajv from "ajv";
import JSON5 from "json5";

const MAX_MCP_SCHEMA_JSON_BYTES = 256 * 1024;
const MAX_MCP_SCHEMA_DEPTH = 32;
const MAX_MCP_SCHEMA_NODES = 2048;

function walkSchema(node: unknown, depth: number, acc: { nodes: number }): string | undefined {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    return `MCP JSON schema nesting depth exceeds ${MAX_MCP_SCHEMA_DEPTH}`;
  }
  if (node === null || typeof node !== "object") {
    return undefined;
  }

  acc.nodes += 1;
  if (acc.nodes > MAX_MCP_SCHEMA_NODES) {
    return `MCP JSON schema node count exceeds ${MAX_MCP_SCHEMA_NODES}`;
  }

  if (!Array.isArray(node) && (node as Record<string, unknown>).$async === true) {
    return "MCP JSON schema uses unsupported asynchronous validation";
  }

  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const error = walkSchema(value, depth + 1, acc);
    if (error) {
      return error;
    }
  }
  return undefined;
}

export function getMcpJsonSchemaBudgetError(schema: unknown): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    // error-policy:J3 schema preflight returns an explicit invalid result below
    return "MCP JSON schema is not JSON-serializable";
  }

  if (serialized === undefined) {
    return "MCP JSON schema is not JSON-serializable";
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_MCP_SCHEMA_JSON_BYTES) {
    return `MCP JSON schema serialized size ${bytes} exceeds ${MAX_MCP_SCHEMA_JSON_BYTES}`;
  }

  return walkSchema(schema, 0, { nodes: 0 });
}

export function parseJSON<T>(input: string): T {
  let cleanedInput = input.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  const firstBrace = cleanedInput.indexOf("{");
  const lastBrace = cleanedInput.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No valid JSON object found in input");
  }

  cleanedInput = cleanedInput.substring(firstBrace, lastBrace + 1);

  return JSON5.parse(cleanedInput) as T;
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
