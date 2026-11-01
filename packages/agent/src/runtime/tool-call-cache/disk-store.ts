/**
 * On-disk tier for the tool-call cache.
 *
 * Layout: <root>/<sha-prefix>/<full-sha>.json
 * The two-char prefix keeps any single directory under a few thousand files
 * even with a million entries.
 *
 * Reads/writes synchronously to keep the wrapping flow simple. Tool calls
 * already cross network or shell boundaries, so a small fs touch is in the
 * noise. Writes go through the privacy redactor before serialisation, and
 * replace the entry file atomically (sibling temp file + rename) so a reader
 * never sees a partially written row.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomicSync } from "@elizaos/core";

import { isRedactionDegraded } from "./redact.ts";
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

    const output = this.redact(entry.output);
    // A truncated or cyclic walk must not persist as a successful disk hit.
    // Evict any existing row so a later degraded rewrite cannot leave the
    // previous successful value to be served by a fresh process.
    if (isRedactionDegraded(output)) {
      this.delete(entry.key);
      return;
    }
    const sanitized: ToolCacheEntry = {
      ...entry,
      output: output as ToolCacheEntry["output"],
    };
    // Replace the file atomically. A plain writeFileSync truncates the target
    // first, so a crash mid-write, or two processes sharing this cache root
    // writing the same key, left a partial or interleaved JSON row that every
    // later read() then failed to parse. The temp-file + rename swap means a
    // reader sees either the previous entry or the complete new one. Mode
    // 0600 / dir 0700 (the helper's defaults) keep cached tool output private.
    writeJsonAtomicSync(file, sanitized, { indent: 0 });
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
