/**
 * Parses bounded BlueBubbles pagination params without loading iMessage runtime.
 * Rejects non-canonical integer spellings (hex, exponent, decimal, padded,
 * spaced) and otherwise clamps to the route's documented caps.
 * Matches upstream consolidate ss251 input-boundary validation (#21682) but
 * extracted for testability.
 */
export const DEFAULT_CHATS_LIMIT = 100;
export const DEFAULT_MESSAGES_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export function parseBlueBubblesLimit(raw: string | null, defaultValue: number): number | null {
  if (raw === null || raw === "") {
    return defaultValue;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }
  return Math.min(parsed, MAX_LIST_LIMIT);
}

export function parseBlueBubblesOffset(raw: string | null): number | null {
  if (raw === null || raw === "") {
    return 0;
  }
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}
