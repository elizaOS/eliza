/** Supplies linear edge trimming for evidence slugs derived from untrusted labels. */

export function trimBoundaryCharacters(
  value: string,
  characters: string,
): string {
  const accepted = new Set(characters);
  let start = 0;
  let end = value.length;
  while (start < end) {
    const codePoint = value.codePointAt(start);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (!accepted.has(character)) break;
    start += character.length;
  }
  while (end > start) {
    let candidate = end - 1;
    const last = value.charCodeAt(candidate);
    if (last >= 0xdc00 && last <= 0xdfff && candidate > start) {
      const previous = value.charCodeAt(candidate - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) candidate -= 1;
    }
    if (!accepted.has(value.slice(candidate, end))) break;
    end = candidate;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
