/**
 * Enforces the byte budget for `$include` files before their contents reach
 * the config parser. The production reader checks the opened descriptor and
 * also stops bounded reads, covering ordinary files, growing files, and
 * streams whose stat size is not useful.
 */

import fs from "node:fs";

/** UTF-8 ceiling for one `$include` file. */
export const MAX_INCLUDE_BYTES = 1_048_576;

const INCLUDE_READ_CHUNK_BYTES = 64 * 1024;

export class IncludeFileTooLargeError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly maxBytes: number,
  ) {
    super(`Include file exceeds ${maxBytes} bytes: ${filePath}`);
    this.name = "IncludeFileTooLargeError";
  }
}

export function isIncludeFileTooLarge(raw: string): boolean {
  return Buffer.byteLength(raw, "utf8") > MAX_INCLUDE_BYTES;
}

/** Reads at most one byte beyond the limit so an oversized source is never retained. */
export function readIncludeFileWithinBudget(filePath: string): string {
  const descriptor = fs.openSync(filePath, "r");
  try {
    if (fs.fstatSync(descriptor).size > MAX_INCLUDE_BYTES) {
      throw new IncludeFileTooLargeError(filePath, MAX_INCLUDE_BYTES);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remainingProbeBytes = MAX_INCLUDE_BYTES + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(
        Math.min(INCLUDE_READ_CHUNK_BYTES, remainingProbeBytes),
      );
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;

      totalBytes += bytesRead;
      if (totalBytes > MAX_INCLUDE_BYTES) {
        throw new IncludeFileTooLargeError(filePath, MAX_INCLUDE_BYTES);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }

    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}
