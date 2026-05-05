import { parseToonKeyValue } from "@elizaos/core";

/** Extract a param value from a TOON LLM response. */
function parsedParams(text: string): Record<string, unknown> {
  const parsed = parseToonKeyValue<Record<string, unknown>>(text);
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
  if (!value) return null;
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

export function extractParamFloat(text: string, name: string): number | null {
  const value = extractParam(text, name);
  if (!value) return null;
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : null;
}
