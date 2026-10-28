export function normalizedInvariantText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

function isInvariantWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{M}\p{N}]/u.test(value);
}

function codePointBefore(value: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const trailing = value.charCodeAt(index - 1);
  if (trailing >= 0xdc00 && trailing <= 0xdfff && index > 1) {
    const leading = value.charCodeAt(index - 2);
    if (leading >= 0xd800 && leading <= 0xdbff) {
      return value.slice(index - 2, index);
    }
  }
  return value[index - 1];
}

function codePointAt(value: string, index: number): string | undefined {
  const point = value.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

/** Match a normalized phrase without treating a short token as a word fragment. */
export function containsInvariantPhrase(
  haystack: string,
  needle: string,
): boolean {
  const normalizedHaystack = normalizedInvariantText(haystack);
  const normalizedNeedle = normalizedInvariantText(needle);
  if (!normalizedNeedle) return false;

  const needleCodePoints = Array.from(normalizedNeedle);
  const firstNeedle = needleCodePoints[0];
  const lastNeedle = needleCodePoints.at(-1);
  let fromIndex = 0;
  while (fromIndex <= normalizedHaystack.length - normalizedNeedle.length) {
    const index = normalizedHaystack.indexOf(normalizedNeedle, fromIndex);
    if (index < 0) return false;
    const before = codePointBefore(normalizedHaystack, index);
    const after = codePointAt(
      normalizedHaystack,
      index + normalizedNeedle.length,
    );
    const startsAtBoundary =
      !isInvariantWordCharacter(firstNeedle) ||
      !isInvariantWordCharacter(before);
    const endsAtBoundary =
      !isInvariantWordCharacter(lastNeedle) || !isInvariantWordCharacter(after);
    if (startsAtBoundary && endsAtBoundary) return true;
    fromIndex = index + 1;
  }
  return false;
}
