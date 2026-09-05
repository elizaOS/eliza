/** Extracts and validates complete JSON model outputs for cloud services. */
import { ElizaError, toWellFormedUnicode } from "@elizaos/core/edge";
import type { z } from "zod";

function extractJsonFromAiResponse(text: string): string {
  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.search(/[{[]/);
  const lastBrace = cleaned.lastIndexOf("}");
  const lastBracket = cleaned.lastIndexOf("]");
  const jsonEnd = Math.max(lastBrace, lastBracket);

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("No JSON found in AI response");
  }

  return cleaned.slice(jsonStart, jsonEnd + 1);
}

export function parseAiJson<T>(text: string, schema: z.ZodType<T>, context?: string): T {
  const extracted = extractJsonFromAiResponse(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (cause) {
    const completeOutput = toWellFormedUnicode(extracted);
    throw new ElizaError(
      `Invalid JSON from AI${context ? ` (${context})` : ""}: ${completeOutput}`,
      {
        code: "AI_JSON_PARSE_FAILED",
        cause,
        context: { operation: context, completeOutput },
      },
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`AI response validation failed${context ? ` (${context})` : ""}: ${issues}`);
  }

  return result.data;
}
