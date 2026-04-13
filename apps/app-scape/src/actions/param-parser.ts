/**
 * Tiny XML-tag parser used by every Action handler to pull parameters
 * out of the free-form LLM response string.
 *
 * The LLM is prompted to emit responses like:
 *
 *   <action>WALK_TO</action>
 *   <destination>varrock west bank</destination>
 *
 * The handler calls `extractParam(text, "destination")` to get
 * `"varrock west bank"`. Works regardless of whitespace inside the
 * tags. Case-insensitive on the tag name so the model doesn't have
 * to be disciplined about casing.
 */

export function extractParam(text: string, name: string): string | null {
  const regex = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim() ?? null;
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
