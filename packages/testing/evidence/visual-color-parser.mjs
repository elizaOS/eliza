/** Parses CSS rgb and rgba function values with a deterministic token scanner. */

/** @param {string} input @returns {[number, number, number, number] | null} */
export function parseRgb(input) {
  const value = String(input);
  const prefixLength = value.startsWith("rgba(")
    ? 5
    : value.startsWith("rgb(")
      ? 4
      : 0;
  if (prefixLength === 0 || !value.endsWith(")")) return null;
  const parts = value
    .slice(prefixLength, -1)
    .split(",")
    .map((part) => part.trim());
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (!parts.every(isUnsignedDecimal)) return null;
  return [
    Number(parts[0]),
    Number(parts[1]),
    Number(parts[2]),
    parts[3] === undefined ? 1 : Number(parts[3]),
  ];
}

function isUnsignedDecimal(value) {
  if (value.length === 0) return false;
  let cursor = 0;
  while (
    cursor < value.length &&
    value.charCodeAt(cursor) >= 48 &&
    value.charCodeAt(cursor) <= 57
  ) {
    cursor += 1;
  }
  if (cursor === 0) return false;
  if (value[cursor] === ".") cursor += 1;
  while (
    cursor < value.length &&
    value.charCodeAt(cursor) >= 48 &&
    value.charCodeAt(cursor) <= 57
  ) {
    cursor += 1;
  }
  return cursor === value.length;
}
