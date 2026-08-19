/**
 * Byte budget for `$include` files. `IncludeProcessor.loadFile` reads the
 * whole file then `JSON5.parse`s it; a hostile include can be gigabytes and
 * hang agent boot. Honest character/config fragments are a few kilobytes.
 */

/** UTF-8 ceiling for one `$include` file. */
export const MAX_INCLUDE_BYTES = 1_048_576;

export function isIncludeFileTooLarge(raw: string): boolean {
  return Buffer.byteLength(raw, "utf8") > MAX_INCLUDE_BYTES;
}
