/**
 * Helper utilities for the OpenRouter plugin.
 */

import { logger } from "@elizaos/core";

/**
 * Get a JSON repair function for fixing malformed JSON.
 *
 * @returns A function that repairs JSON text or undefined
 */
export function getJsonRepairFunction(): ((text: string) => string) | undefined {
  try {
    const { jsonrepair } = require("jsonrepair");
    return jsonrepair;
  } catch {
    return undefined;
  }
}

/**
 * Handle object generation errors and return a fallback response.
 *
 * @param error - The error that occurred
 * @returns A fallback error object
 */
export function handleObjectGenerationError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Error generating object: ${message}`);
  return { error: message };
}

/**
 * Extract JSON from text that may contain markdown code blocks.
 *
 * @param text - The text containing JSON
 * @returns Extracted JSON object or empty object
 */
export function extractJsonFromText(text: string): Record<string, unknown> {
  // Try direct parsing first
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Continue to extraction methods
  }

  // Try extracting from code blocks
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch?.[1]) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim()) as Record<string, unknown>;
    } catch {
      // Continue
    }
  }

  // Try any code block
  const codeBlockMatch = text.match(/```\w*\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const content = codeBlockMatch[1].trim();
    if (content.startsWith("{") && content.endsWith("}")) {
      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        // Continue
      }
    }
  }

  // Try finding JSON object in text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    try {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      // Continue
    }
  }

  return {};
}
