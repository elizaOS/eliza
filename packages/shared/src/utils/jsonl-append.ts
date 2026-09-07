/**
 * Appends one record to an append-only JSONL file without letting a torn
 * predecessor swallow it. Writers such as the usage counters, the consumer
 * metering log, and the capability audit log append `JSON.stringify(record)`
 * plus a newline, and their readers split on newlines and skip lines that do
 * not parse. A crash, signal, or full disk between a record and its newline
 * leaves a torn final line with no newline, and a plain append would then
 * land the next record on that same line, so the reader would discard the
 * intact record together with the torn bytes. This helper writes a newline
 * first whenever the file does not already end with one, so torn bytes stay
 * on their own line and every record written afterwards is readable.
 *
 * The tail check and the append are two operations, so concurrent writers to
 * one file still need their own serialization; the callers here are either
 * single-process or lock-serialized.
 */

import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";

export interface AppendJsonlRecordOptions {
  /** File mode applied when the append creates the file. */
  readonly mode?: number;
}

/**
 * Append `record` as one JSON line, isolating any torn line the file already
 * ends with. Creates the file when it does not exist.
 */
export function appendJsonlRecord(
  file: string,
  record: unknown,
  options: AppendJsonlRecordOptions = {},
): void {
  const line = `${JSON.stringify(record)}\n`;
  const payload = fileEndsWithNewline(file) ? line : `\n${line}`;
  appendFileSync(file, payload, {
    encoding: "utf8",
    flag: "a",
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
}

/** True for a missing or empty file, or one whose last byte is `\n`. */
function fileEndsWithNewline(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    // error-policy:J3 a missing file has no torn tail; every other open
    // failure is reported by the append that follows.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
