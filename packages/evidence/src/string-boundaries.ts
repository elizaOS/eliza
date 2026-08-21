/** Supplies linear edge trimming for evidence slugs derived from untrusted labels. */

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
