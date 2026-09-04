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
 *
 * Nothing on disk is trusted. A row is data this process did not produce: an
 * earlier version wrote it, a crash truncated it, or something else edited the
 * state directory. So {@link DiskStore.read} validates the parsed row against
 * {@link ToolCacheEntry} instead of casting to it, and treats every failure as
 * a miss that also evicts the offending file. Two properties fall out of that:
 *
 *   - The cache can never fail a tool call. `ToolCallCache.run` calls `read`
 *     on the synchronous path before the executor, so a throw here does not
 *     degrade to a miss — it propagates to the caller and the tool never runs
 *     at all (error-policy:J7 — "the cache is optional degradation, not the
 *     tool call"). A malformed row used to throw `SyntaxError` out of `run`.
 *   - A bad row cannot poison a key forever. Since the read path never
 *     rewrote or removed the file it rejected, the same key threw on every
 *     later call, in this process and every future one, until someone deleted
 *     the state directory by hand. Eviction makes the next call a clean miss
 *     that repopulates the row.
 *
 * Writes are atomic (temp file in the same directory, then `rename`) because
 * the read path's robustness is not a licence to produce partial rows: a
 * `writeFileSync` interrupted by a crash, a signal or a full disk left exactly
 * the truncated JSON described above.
 *
 * For the same reason neither `read` nor `write` throws. Both sit on the tool
 * call's own path — `write` runs in `run`'s `.then`, where a raised `ENOSPC`
 * or `EACCES` rejects a call whose tool had *already succeeded* and discards
 * its result. Populating or evicting a cache row is best-effort by nature, so
 * an fs failure is logged and swallowed. Only the tool's own error belongs to
 * the caller.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { logger } from "@elizaos/core";

import { isRedactionDegraded } from "./redact.ts";
import type { PrivacyRedactor, ToolCacheEntry } from "./types.ts";

/**
 * Does a parsed disk row conform to {@link ToolCacheEntry} and belong to `key`?
 *
 * Every scalar field the read path or `ToolCallCache.getByKey` goes on to
 * *compare* is checked here, because a missing or wrongly-typed one does not
 * fail loudly — it fails as a silently wrong decision. The motivating case is
 * `expiresAt`: `getByKey` tests `candidate.expiresAt <= this.now()`, and when
 * the field is absent that comparison is `undefined <= now`, which is `false`.
 * The row reads as not-yet-expired at every clock value, so a TTL-less entry
 * was served forever and the tool it caches never ran again.
 *
 * `output` is checked for presence only, not shape. It is legitimately `null`,
 * `0` or `false`, so presence must be `in` rather than a truthiness test, and
 * validating the payload itself would mean a deep walk of untrusted data that
 * `isRedactionDegraded` here and `shouldCache` in `ToolCallCache.run` already
 * perform on the way out.
 */
function isStoredEntry(parsed: unknown, key: string): parsed is ToolCacheEntry {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const row = parsed as Partial<ToolCacheEntry>;
  return (
    row.key === key &&
    typeof row.toolName === "string" &&
    typeof row.toolVersion === "string" &&
    Number.isFinite(row.cachedAt) &&
    Number.isFinite(row.expiresAt) &&
    "output" in row
  );
}

export class DiskStore {
  constructor(
    private readonly root: string,
    private readonly redact: PrivacyRedactor,
  ) {}

  private pathFor(key: string): string {
    return path.join(this.root, key.slice(0, 2), `${key}.json`);
  }

  /**
   * Remove a row, absorbing any fs failure.
   *
   * Eviction is a repair step on a path that must not throw, and the thing
   * being repaired is by definition an unexpected file — including one that is
   * not a regular file at all, which `delete`'s non-recursive `rmSync` refuses.
   */
  private evict(key: string): void {
    try {
      this.delete(key);
    } catch (error) {
      logger.warn(
        { key, error },
        "[DiskStore] could not evict an unreadable cache row",
      );
    }
  }

  read(key: string): ToolCacheEntry | undefined {
    const file = this.pathFor(key);
    if (!existsSync(file)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Truncated, empty, unreadable or non-JSON row: a miss, and drop it so
      // the next call repopulates instead of failing again.
      this.evict(key);
      return undefined;
    }
    if (!isStoredEntry(parsed, key)) {
      this.evict(key);
      return undefined;
    }
    return parsed;
  }

  write(entry: ToolCacheEntry): void {
    const file = this.pathFor(entry.key);
    const output = this.redact(entry.output);
    // A truncated or cyclic walk must not persist as a successful disk hit.
    // Evict any existing row so a later degraded rewrite cannot leave the
    // previous successful value to be served by a fresh process.
    if (isRedactionDegraded(output)) {
      this.evict(entry.key);
      return;
    }
    const sanitized: ToolCacheEntry = {
      ...entry,
      output: output as ToolCacheEntry["output"],
    };
    // Atomic publish: a reader either sees the previous row or this one, never
    // a half-written one. Same directory, so `rename` stays on one filesystem.
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const dir = path.dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(temp, JSON.stringify(sanitized), "utf8");
      renameSync(temp, file);
    } catch (error) {
      try {
        if (existsSync(temp)) rmSync(temp, { force: true });
      } catch {
        // Nothing further to do; the temp name is unique so a leftover cannot
        // be mistaken for a row.
      }
      logger.warn(
        { key: entry.key, toolName: entry.toolName, error },
        "[DiskStore] could not persist a cache row; continuing uncached",
      );
    }
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
