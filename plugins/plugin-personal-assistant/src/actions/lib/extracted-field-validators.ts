/**
 * Field validators shared by the LLM task extractors (`extract-task-plan.ts`
 * for create, `extract-update-fields.ts` for update). Keeping one copy means
 * the create and update paths normalize model output the same way: a
 * `cadenceKind` of "Weekly" or a window of " morning " is accepted on both.
 */

export function validateTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Trim + lowercase, then accept only kinds in the caller's allowed set. */
export function validateCadenceKind<K extends string>(
  value: unknown,
  allowed: ReadonlySet<K>,
): K | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized as K) ? (normalized as K) : null;
}

export function validateWindows(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .filter((item: unknown) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : null;
}

export function validateWeekdays(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value.filter(
    (item: unknown) =>
      typeof item === "number" &&
      Number.isInteger(item) &&
      item >= 0 &&
      item <= 6,
  );
  return normalized.length > 0 ? normalized : null;
}

export function validatePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

export function validatePriority(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.min(5, Math.round(value)));
}
