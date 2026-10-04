/** Same-directory replacement for small host registries; callers retain schema and concurrency policy. */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
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
    renameSync(temporary, filePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
