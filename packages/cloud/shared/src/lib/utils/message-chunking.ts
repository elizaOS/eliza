/** Validates caller-supplied UTF-16 message chunk limits before splitting. */

export function assertValidMessageChunkLength(maxLength: number): void {
  if (!Number.isFinite(maxLength) || !Number.isInteger(maxLength) || maxLength < 2) {
    throw new RangeError("maxLength must be a finite integer of at least 2 UTF-16 code units");
  }
}

/** Split UTF-16 text into bounded chunks whose concatenation is byte-for-byte exact. */
export function splitMessageLosslessly(text: string, maxLength: number): string[] {
  assertValidMessageChunkLength(maxLength);
  if (!text) return [];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxLength, text.length);
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    ) {
      end -= 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}
