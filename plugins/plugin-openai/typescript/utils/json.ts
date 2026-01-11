/**
 * JSON utilities for OpenAI plugin
 *
 * Provides JSON parsing and repair functionality.
 */

import { logger } from "@elizaos/core";
import { JSONParseError } from "ai";

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for JSON repair function
 */
interface JsonRepairParams {
  /** The text that failed to parse */
  text: string;
  /** The error that occurred */
  error: Error;
}

/**
 * JSON repair function signature
 */
type JsonRepairFunction = (params: JsonRepairParams) => Promise<string | null>;

// ============================================================================
// Constants
// ============================================================================

/**
 * Regex patterns for cleaning JSON output
 */
const JSON_CLEANUP_PATTERNS = {
  /** Matches markdown code blocks with json tag */
  MARKDOWN_JSON: /```json\n|\n```|```/g,
  /** Matches leading/trailing whitespace */
  WHITESPACE: /^\s+|\s+$/g,
} as const;

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Creates a JSON repair function for use with AI SDK's generateObject.
 *
 * This function attempts to fix common JSON formatting issues:
 * - Removes markdown code block wrappers (```json ... ```)
 * - Trims whitespace
 *
 * @returns A repair function that attempts to fix JSON text
 */
export function getJsonRepairFunction(): JsonRepairFunction {
  return async ({ text, error }: JsonRepairParams): Promise<string | null> => {
    // Only attempt repair for JSON parse errors
    if (!(error instanceof JSONParseError)) {
      return null;
    }

    try {
      // Remove markdown code block wrappers
      const cleanedText = text.replace(JSON_CLEANUP_PATTERNS.MARKDOWN_JSON, "");

      // Validate the cleaned JSON parses correctly
      JSON.parse(cleanedText);

      logger.debug("[JSON Repair] Successfully repaired JSON by removing markdown wrappers");
      return cleanedText;
    } catch {
      logger.warn("[JSON Repair] Unable to repair JSON text");
      return null;
    }
  };
}

/**
 * Attempts to parse JSON with automatic repair.
 *
 * @param text - The text to parse
 * @returns The parsed JSON object
 * @throws Error if parsing fails and repair is not possible
 */
export function parseJsonWithRepair<T>(text: string): T {
  // First, try direct parse
  try {
    return JSON.parse(text) as T;
  } catch (firstError) {
    // Try removing markdown wrappers
    const cleanedText = text.replace(JSON_CLEANUP_PATTERNS.MARKDOWN_JSON, "");

    try {
      return JSON.parse(cleanedText) as T;
    } catch {
      // Re-throw the original error with context
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      throw new Error(`Failed to parse JSON: ${message}`);
    }
  }
}

/**
 * Safely stringifies a value to JSON.
 *
 * Handles circular references and special types.
 *
 * @param value - The value to stringify
 * @param indent - Number of spaces for indentation
 * @returns The JSON string
 */
export function safeStringify(value: unknown, indent = 0): string {
  const seen = new WeakSet();

  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) {
        return "[Circular]";
      }
      seen.add(val);
    }

    // Handle special types
    if (typeof val === "bigint") {
      return val.toString();
    }

    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
      };
    }

    if (val instanceof Date) {
      return val.toISOString();
    }

    if (val instanceof Map) {
      return Object.fromEntries(val);
    }

    if (val instanceof Set) {
      return Array.from(val);
    }

    return val;
  };

  return JSON.stringify(value, replacer, indent);
}
