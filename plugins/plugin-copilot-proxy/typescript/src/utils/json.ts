import type { ExtractedJSON, JsonObject, UnstructuredResponse } from "../types";

/**
 * Extract and parse JSON from a text response.
 */
export function extractAndParseJSON(text: string): ExtractedJSON {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as JsonObject;
    }
  } catch {
    // Continue to other extraction methods
  }

  // Try extracting from JSON code block
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    try {
      const content = jsonBlockMatch[1].trim();
      const parsed = JSON.parse(content);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as JsonObject;
      }
    } catch {
      // Continue
    }
  }

  // Try extracting from any code block
  const anyBlockMatch = text.match(/```(?:\w*)\s*([\s\S]*?)\s*```/);
  if (anyBlockMatch) {
    const content = anyBlockMatch[1].trim();
    if (content.startsWith("{") && content.endsWith("}")) {
      try {
        const parsed = JSON.parse(content);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          return parsed as JsonObject;
        }
      } catch {
        // Continue
      }
    }
  }

  // Try finding JSON object in text
  const jsonObject = findJsonObject(text);
  if (jsonObject) {
    try {
      const parsed = JSON.parse(jsonObject);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as JsonObject;
      }
    } catch {
      // Continue
    }
  }

  // Return unstructured response as fallback
  return {
    type: "unstructured_response",
    content: text,
  } as UnstructuredResponse;
}

/**
 * Find a JSON object in text.
 */
function findJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  let best: string | null = null;
  let depth = 0;
  let start: number | null = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && start !== null) {
        const candidate = text.slice(start, i + 1);
        if (best === null || candidate.length > best.length) {
          best = candidate;
        }
      }
    }
  }

  return best;
}

/**
 * Validate that a value is a valid JSON object.
 */
export function isValidJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
