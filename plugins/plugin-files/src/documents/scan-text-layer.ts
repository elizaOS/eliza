/** Coordinates are normalized to the exact reviewed image, with a top-left origin. */
export type ScanTextLine = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export function validateScanTextLayer(lines: ScanTextLine[]) {
  if (!Array.isArray(lines) || lines.length > 2000)
    throw Error("Choose at most 2,000 text lines per page.");
  let length = 0;
  for (const line of lines) {
    if (
      !line ||
      typeof line.text !== "string" ||
      line.text.length > 4000 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted input.
      /[\r\n\u0000-\u0008\u000b-\u001f]/.test(line.text) ||
      ![line.x, line.y, line.width, line.height].every(Number.isFinite) ||
      line.x < 0 ||
      line.y < 0 ||
      line.width <= 0 ||
      line.height <= 0 ||
      line.x + line.width > 1.000001 ||
      line.y + line.height > 1.000001
    )
      throw Error("Invalid scanned line or position.");
    length += line.text.length;
  }
  if (length > 100000) throw Error("Page text exceeds 100,000 characters.");
}
