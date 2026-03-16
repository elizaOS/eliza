import { logger } from "@elizaos/core";
import { JSONParseError } from "ai";

interface JsonRepairParams {
  text: string;
  error: Error;
}

type JsonRepairFunction = (params: JsonRepairParams) => Promise<string | null>;

const JSON_CLEANUP_PATTERNS = {
  MARKDOWN_JSON: /```json\n|\n```|```/g,
  WHITESPACE: /^\s+|\s+$/g,
} as const;

export function getJsonRepairFunction(): JsonRepairFunction {
  return async ({ text, error }: JsonRepairParams): Promise<string | null> => {
    if (!(error instanceof JSONParseError)) {
      return null;
    }
    try {
      const cleanedText = text.replace(JSON_CLEANUP_PATTERNS.MARKDOWN_JSON, "");
      JSON.parse(cleanedText);
      logger.debug("[JSON Repair] Successfully repaired JSON by removing markdown wrappers");
      return cleanedText;
    } catch {
      logger.warn("[JSON Repair] Unable to repair JSON text");
      return null;
    }
  };
}

export function parseJsonWithRepair<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (firstError) {
    const cleanedText = text.replace(JSON_CLEANUP_PATTERNS.MARKDOWN_JSON, "");
    try {
      return JSON.parse(cleanedText) as T;
    } catch {
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      throw new Error(`Failed to parse JSON: ${message}`);
    }
  }
}

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
