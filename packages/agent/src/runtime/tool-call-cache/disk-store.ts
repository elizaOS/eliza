/**
 * On-disk tier for the tool-call cache.
 *
 * Layout: <root>/<sha-prefix>/<full-sha>.json
 * The two-char prefix keeps any single directory under a few thousand files
 * even with a million entries.
 *
 * Reads/writes synchronously to keep the wrapping flow simple. Tool calls
 * already cross network or shell boundaries, so a small fs touch is in the
 * noise. Writes go through the privacy redactor before serialisation.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { PrivacyRedactor, ToolCacheEntry } from "./types.ts";

export class DiskStore {
  constructor(
    private readonly root: string,
    private readonly redact: PrivacyRedactor,
  ) {}

  private pathFor(key: string): string {
    return path.join(this.root, key.slice(0, 2), `${key}.json`);
  }

  read(key: string): ToolCacheEntry | undefined {
    const file = this.pathFor(key);
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ToolCacheEntry;
    if (parsed.key !== key) return undefined;
    return parsed;
  }

  write(entry: ToolCacheEntry): void {
    const file = this.pathFor(entry.key);
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const sanitized: ToolCacheEntry = {
      ...entry,
      output: this.redact(entry.output) as ToolCacheEntry["output"],
    };
    writeFileSync(file, JSON.stringify(sanitized), "utf8");
  }

  delete(key: string): void {
    const file = this.pathFor(key);
    if (existsSync(file)) rmSync(file, { force: true });
  }

  clear(): void {
    if (existsSync(this.root)) {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
