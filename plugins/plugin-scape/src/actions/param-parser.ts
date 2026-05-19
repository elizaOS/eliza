import { parseJSONObjectFromText } from "@elizaos/core";

/**
 * Tiny JSON field parser used by Action handlers to pull parameters out of the
 * LLM response string.
 */

function parsedParams(text: string): Record<string, unknown> {
  const parsed = parseJSONObjectFromText(text) as Record<
    string,
    unknown
  > | null;
  const nested =
    parsed && typeof parsed.params === "object" && !Array.isArray(parsed.params)
      ? (parsed.params as Record<string, unknown>)
      : null;
  return nested ?? parsed ?? {};
}

function getParamValue(text: string, name: string): unknown {
  const params = parsedParams(text);
  if (name in params) return params[name];

  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(params)) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }

  return null;
}

export function extractParam(text: string, name: string): string | null {
  const value = getParamValue(text, name);
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const textValue = String(value).trim();
    return textValue.length > 0 ? textValue : null;
  }
  return null;
}

export function extractParamInt(text: string, name: string): number | null {
  const value = extractParam(text, name);
  if (value === null) return null;
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

export function extractParamFloat(text: string, name: string): number | null {
  const value = extractParam(text, name);
  if (value === null) return null;
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

/** Returns true if the extracted param is literally "true" / "yes" / "1". */
export function extractParamBool(text: string, name: string): boolean {
  const value = extractParam(text, name);
  if (value === null) return false;
  const lower = value.trim().toLowerCase();
  return lower === "true" || lower === "yes" || lower === "1" || lower === "y";
}
