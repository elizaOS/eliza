import Ajv from "ajv";
import JSON5 from "json5";

/** Find matching closing bracket/brace using depth counting */
function findMatchingClose(str: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseJSON<T>(input: string): T {
  // Remove code blocks
  let cleanedInput = input.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  // Find first JSON start character
  const firstBrace = cleanedInput.indexOf("{");
  const firstBracket = cleanedInput.indexOf("[");

  // Determine which comes first (or only one exists)
  let start = -1;
  let isArray = false;

  if (firstBrace === -1 && firstBracket === -1) {
    // No JSON found, try parsing as-is (might be primitive)
    return JSON5.parse(cleanedInput);
  } else if (firstBrace === -1) {
    start = firstBracket;
    isArray = true;
  } else if (firstBracket === -1) {
    start = firstBrace;
    isArray = false;
  } else {
    // Both exist, use whichever comes first
    if (firstBracket < firstBrace) {
      start = firstBracket;
      isArray = true;
    } else {
      start = firstBrace;
      isArray = false;
    }
  }

  // Find matching closing character
  const end = isArray
    ? findMatchingClose(cleanedInput, start, "[", "]")
    : findMatchingClose(cleanedInput, start, "{", "}");

  if (end !== -1) {
    cleanedInput = cleanedInput.substring(start, end + 1);
  }

  return JSON5.parse(cleanedInput);
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

export function validateJsonSchema<T = unknown>(
  data: unknown,
  schema: Record<string, unknown>,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (!valid) {
      const errors = (validate.errors || []).map(
        (err: { instancePath?: string; message?: string }) => {
          const path = err.instancePath ? `${err.instancePath.replace(/^\//, "")}` : "value";
          return `${path}: ${err.message}`;
        },
      );

      return { success: false, error: errors.join(", ") };
    }

    return { success: true, data: data as T };
  } catch (error) {
    return {
      success: false,
      error: `Schema validation error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
