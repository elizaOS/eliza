/**
 * JSON parsing helpers for LLM output.
 *
 * WHY: Model output commonly includes trailing commas, single quotes, unquoted
 * keys, or fenced code blocks. Keep the tolerant extraction/parsing path in a
 * dedicated helper so callers parsing LLM text do not each reinvent it.
 */

import JSON5 from "json5";
import { logger } from "../logger.js";

const jsonBlockPattern = /```json\n([\s\S]*?)\n```/;

export function normalizeJsonLikeString(value: string): string {
  let normalized = value.replace(/\{\s+/, "{").replace(/\s+\}/, "}").trim();

  normalized = normalized.replace(
    /("[\w\d_-]+")\s*: \s*(?!"|\[)([\s\S]+?)(?=(,\s*"|\}$))/g,
    '$1: "$2"',
  );

  normalized = normalized.replace(
    /"([^"]+)"\s*:\s*'([^']*)'/g,
    (_match, key, innerValue) => `"${key}": "${innerValue}"`,
  );

  normalized = normalized.replace(
    /("[\w\d_-]+")\s*:\s*([A-Za-z_]+)(?!["\w])/g,
    '$1: "$2"',
  );

  return normalized;
}

export function extractAndParseJSONObjectFromText(
  text: string,
): Record<string, unknown> | null {
  const jsonBlockMatch = text.match(jsonBlockPattern);
  let jsonData: Record<string, unknown> | null = null;

  try {
    if (jsonBlockMatch) {
      jsonData = JSON5.parse(
        normalizeJsonLikeString(jsonBlockMatch[1].trim()),
      ) as Record<string, unknown>;
    } else {
      jsonData = JSON5.parse(
        normalizeJsonLikeString(text.trim()),
      ) as Record<string, unknown>;
    }
  } catch {
    logger.warn(
      { src: "core:utils:json-llm" },
      "Could not parse text as JSON, returning null",
    );
    return null;
  }

  if (jsonData && typeof jsonData === "object" && !Array.isArray(jsonData)) {
    return jsonData;
  }

  return null;
}
