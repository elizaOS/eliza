/**
 * Folds owner-typed text and item titles the same way for the owner actions
 * and the owner item lookup.
 */

/** Fold unicode spaces and whitespace runs so typed and stored text match. */
export function normalizeLifeInputText(value: string): string {
  return value
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(value: string): string {
  return normalizeLifeInputText(value).toLowerCase();
}
