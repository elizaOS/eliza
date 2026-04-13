/** Extract a param value from LLM response XML-style tags */
export function extractParam(text: string, name: string): string | null {
  const regex = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim() ?? null;
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
