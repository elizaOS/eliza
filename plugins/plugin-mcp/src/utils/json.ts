import { parseToonKeyValue } from "@elizaos/core";
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
});

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
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const errors = validate.errors ?? [];
    const errorMessage = formatAjvErrors(errors);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripOpeningFence(input: string): string {
  return input
    .trim()
    .replace(/^```(?:json|toon)?\s*/i, "")
    .trim();
}

function looksLikeLegacyJsonObject(input: string): boolean {
  return stripOpeningFence(input).startsWith("{");
}

function tryParseToonRecord(input: string): Record<string, unknown> | null {
  const parsed = parseToonKeyValue<Record<string, unknown>>(input);
  return isRecord(parsed) ? parsed : null;
}

export function parseStructuredModelOutput<T = Record<string, unknown>>(input: string): T {
  const errors: string[] = [];
  const legacyJsonFirst = looksLikeLegacyJsonObject(input);

  if (!legacyJsonFirst) {
    const toonRecord = tryParseToonRecord(input);
    if (toonRecord) {
      return toonRecord as T;
    }
    errors.push("TOON/plain-text parse failed");
  }

  try {
    return parseJSON<T>(input);
  } catch {
    errors.push("legacy structured-object parse failed");
  }

  if (legacyJsonFirst) {
    const toonRecord = tryParseToonRecord(input);
    if (toonRecord) {
      return toonRecord as T;
    }
    errors.push("TOON/plain-text parse failed");
  }

  throw new Error(
    `No valid TOON/plain-text or legacy structured object found: ${errors.join("; ")}`
  );
}
