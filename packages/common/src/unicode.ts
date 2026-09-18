/** Unicode-safe string boundaries, shared by runtime and client diagnostics. */
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

/**
 * Returns `text` with every lone surrogate replaced by U+FFFD. Well-formed
 * input is returned as the same string instance (the native fast path scans
 * without allocating).
 */
export function toWellFormedUnicode(text: string): string {
  return text.toWellFormed();
}

/**
 * `text.slice(0, maxLength)` that never splits a surrogate pair: when the cut
 * would end on a high surrogate (the lead half of an emoji), the boundary
 * backs off by one code unit. Pre-existing lone surrogates are preserved —
 * sanitizing malformed input is {@link toWellFormedUnicode}'s job.
 */
export function truncateWellFormed(text: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  const end =
    isHighSurrogate(text.charCodeAt(maxLength - 1)) &&
    isLowSurrogate(text.charCodeAt(maxLength))
      ? maxLength - 1
      : maxLength;
  return text.slice(0, end);
}

/**
 * Keeps the LAST `maxLength` code units of `text` without starting on the low
 * half of a split surrogate pair (the tail-side dual of
 * {@link truncateWellFormed}).
 */
export function tailWellFormed(text: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  let start = text.length - maxLength;
  if (
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start++;
  }
  return text.slice(start);
}
