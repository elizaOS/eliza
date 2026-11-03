/** Extracts and validates complete JSON model outputs for cloud services. */
import { ElizaError, parseJsonObject, toWellFormedUnicode } from "@elizaos/core";
import type { z } from "zod";

/**
 * Read the JSON object in a model reply. Core's tolerant reader skips prose
 * around the object, so a `[` before it or a `{…}` note after it does not
 * break the parse.
 */
export function parseAiJsonObject(text: string, context?: string): Record<string, unknown> {
  const parsed = parseJsonObject<Record<string, unknown>>(text);
  if (parsed) return parsed;

  const completeOutput = toWellFormedUnicode(text.trim());
  throw new ElizaError(`Invalid JSON from AI${context ? ` (${context})` : ""}: ${completeOutput}`, {
    code: "AI_JSON_PARSE_FAILED",
    context: { operation: context, completeOutput },
  });
}

export function parseAiJson<T>(text: string, schema: z.ZodType<T>, context?: string): T {
  const result = schema.safeParse(parseAiJsonObject(text, context));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`AI response validation failed${context ? ` (${context})` : ""}: ${issues}`);
  }

  return result.data;
}
