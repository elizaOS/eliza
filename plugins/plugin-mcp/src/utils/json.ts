import Ajv from "ajv";
import JSON5 from "json5";

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

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

interface AjvError {
  readonly instancePath: string;
  readonly message?: string;
}

function formatAjvErrors(errors: readonly AjvError[]): string {
  return errors
    .map((err) => {
      const path = err.instancePath ? `${err.instancePath.replace(/^\//, "")}` : "value";
      return `${path}: ${err.message ?? "validation failed"}`;
    })
    .join(", ");
}

export function validateJsonSchema<T>(
  data: unknown,
  schema: Readonly<Record<string, unknown>>
): { success: true; data: T } | { success: false; error: string } {
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const errors = validate.errors ?? [];
    const errorMessage = formatAjvErrors(errors as readonly AjvError[]);
    return { success: false, error: errorMessage };
  }

  return { success: true, data: data as T };
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
