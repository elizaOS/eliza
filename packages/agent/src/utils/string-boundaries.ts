/** Provides linear-time suffix trimming for agent transport normalization. */

export function trimEndCharacters(value: string, characters: string): string {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1])) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
