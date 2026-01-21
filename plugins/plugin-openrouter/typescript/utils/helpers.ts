import { type JsonValue, logger } from "@elizaos/core";

export function getJsonRepairFunction(): ((text: string) => string) | undefined {
  try {
    const { jsonrepair } = require("jsonrepair");
    return jsonrepair;
  } catch {
    return undefined;
  }
}

export function handleObjectGenerationError(error: unknown): Record<string, JsonValue> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Error generating object: ${message}`);
  return { error: message };
}

export function extractJsonFromText(text: string): Record<string, JsonValue> {
  try {
    return JSON.parse(text) as Record<string, JsonValue>;
  } catch {}

  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch?.[1]) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim()) as Record<string, JsonValue>;
    } catch {}
  }

  const codeBlockMatch = text.match(/```\w*\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const content = codeBlockMatch[1].trim();
    if (content.startsWith("{") && content.endsWith("}")) {
      try {
        return JSON.parse(content) as Record<string, JsonValue>;
      } catch {}
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    try {
      return JSON.parse(jsonMatch[0]) as Record<string, JsonValue>;
    } catch {}
  }

  return {};
}
