const MODEL_CODE_FENCE_PATTERN =
  /^\s*```(?:json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i;

function stripModelWrappers(raw: string): string {
  let candidate = raw.trim();
  const thinkEnd = candidate.indexOf("</think>");
  if (candidate.startsWith("<think>") && thinkEnd !== -1) {
    candidate = candidate.slice(thinkEnd + "</think>".length).trim();
  }
  const fenced = candidate.match(MODEL_CODE_FENCE_PATTERN);
  if (fenced) {
    candidate = (fenced[1] ?? "").trim();
  }
  return candidate;
}

export function parseJsonModelOutput(raw: string): unknown | null {
  const candidate = stripModelWrappers(raw);
  if (candidate.length === 0) {
    return null;
  }
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

export function parseJsonModelRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(raw: string): T | null {
  const parsed = parseJsonModelOutput(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as T;
}

export function parseJsonModelArray<T = unknown>(raw: string): T[] | null {
  const parsed = parseJsonModelOutput(raw);
  return Array.isArray(parsed) ? (parsed as T[]) : null;
}
