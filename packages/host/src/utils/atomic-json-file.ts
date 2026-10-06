/** Same-directory replacement for small host registries; callers retain schema and concurrency policy. */
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: { createOnly?: boolean } = {},
): void {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined)
    throw new TypeError("JSON root must be serializable");
  let mode: number | undefined;
  try {
    const existing = lstatSync(filePath);
    if (existing.isFile()) mode = existing.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, ".registry-write-"));
  try {
    const temporary = join(staging, "value.json");
    writeFileSync(temporary, `${serialized}\n`, { encoding: "utf8", mode });
    // The creation mode is filtered by the process umask; restore the replaced
    // file's exact mode so a shared (for example 0664) registry stays shared.
    if (mode !== undefined) chmodSync(temporary, mode);
    if (options.createOnly) linkSync(temporary, filePath);
    else renameSync(temporary, filePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
