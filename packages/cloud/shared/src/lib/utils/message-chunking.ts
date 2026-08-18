/** Validates caller-supplied UTF-16 message chunk limits before splitting. */

export function assertValidMessageChunkLength(maxLength: number): void {
  if (!Number.isFinite(maxLength) || !Number.isInteger(maxLength) || maxLength < 2) {
    throw new RangeError("maxLength must be a finite integer of at least 2 UTF-16 code units");
  }
}
