/**
 * Linear-time string boundary helpers for trimming small, explicit character
 * sets without backtracking regular expressions.
 */

/** Remove characters from the start while they belong to `characters`. */
export function trimStartCharacters(value: string, characters: string): string {
  let start = 0;
  while (start < value.length && characters.includes(value[start])) start += 1;
  return start === 0 ? value : value.slice(start);
}

/** Remove characters from the end while they belong to `characters`. */
export function trimEndCharacters(value: string, characters: string): string {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1])) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** Remove characters from both boundaries with one scan per boundary. */
export function trimBoundaryCharacters(
  value: string,
  characters: string,
): string {
  let start = 0;
  let end = value.length;
  while (start < end && characters.includes(value[start])) start += 1;
  while (end > start && characters.includes(value[end - 1])) end -= 1;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
