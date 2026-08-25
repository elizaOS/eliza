/**
 * Linear-time string boundary helpers for trimming small, explicit character
 * sets without backtracking regular expressions.
 */

/** Remove characters from the start while they belong to `characters`. */
export function trimStartCharacters(value: string, characters: string): string {
  const accepted = new Set(characters);
  let start = 0;
  while (start < value.length) {
    const codePoint = value.codePointAt(start);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (!accepted.has(character)) break;
    start += character.length;
  }
  return start === 0 ? value : value.slice(start);
}

function previousCharacterStart(value: string, end: number): number {
  const last = value.charCodeAt(end - 1);
  if (last >= 0xdc00 && last <= 0xdfff && end > 1) {
    const previous = value.charCodeAt(end - 2);
    if (previous >= 0xd800 && previous <= 0xdbff) return end - 2;
  }
  return end - 1;
}

/** Remove characters from the end while they belong to `characters`. */
export function trimEndCharacters(value: string, characters: string): string {
  const accepted = new Set(characters);
  let end = value.length;
  while (end > 0) {
    const start = previousCharacterStart(value, end);
    if (!accepted.has(value.slice(start, end))) break;
    end = start;
  }
  return end === value.length ? value : value.slice(0, end);
}

/** Remove characters from both boundaries with one scan per boundary. */
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
    const candidate = previousCharacterStart(value, end);
    if (!accepted.has(value.slice(candidate, end))) break;
    end = candidate;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
