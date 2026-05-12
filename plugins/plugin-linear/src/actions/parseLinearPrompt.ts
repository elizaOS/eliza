const EMPTY_SCALAR_VALUES = new Set(["", "none", "null", "undefined", "n/a", "not provided"]);

const EMPTY_LIST_VALUES = new Set([...EMPTY_SCALAR_VALUES, "clear", "clear all", "no labels"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeListEntry(value: string): string {
  return stripWrappingQuotes(value.replace(/^\s*[-*]\s*/, "").trim());
}

function splitListString(value: string): string[] {
  let trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    trimmed = trimmed.slice(1, -1);
  }

  return trimmed.split(/[,\n]/).map(normalizeListEntry).filter(Boolean);
}

export function parseLinearPromptResponse(response: string): Record<string, unknown> {
  try {
    const trimmed = response.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fenced?.[1] ?? trimmed).trim();
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return {};
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getRecordValue(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().startsWith("{")) {
    const parsed = parseLinearPromptResponse(value);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  }

  return undefined;
}

export function getStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = stripWrappingQuotes(value);
    return EMPTY_SCALAR_VALUES.has(normalized.toLowerCase()) ? undefined : normalized;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

export function getStringArrayValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (entry == null) {
          return [];
        }
        if (typeof entry === "string") {
          return splitListString(entry);
        }
        return [String(entry)];
      })
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const normalized = stripWrappingQuotes(value);
    if (EMPTY_LIST_VALUES.has(normalized.toLowerCase())) {
      return [];
    }
    return splitListString(normalized);
  }

  return undefined;
}

export function getBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "n"].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

export function getNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function getPriorityNumberValue(value: unknown): number | undefined {
  const numeric = getNumberValue(value);
  if (numeric) {
    return numeric;
  }

  const priority = getStringValue(value)?.toLowerCase();
  if (!priority) {
    return undefined;
  }

  const priorityMap: Record<string, number> = {
    urgent: 1,
    high: 2,
    normal: 3,
    medium: 3,
    low: 4,
  };

  return priorityMap[priority];
}
