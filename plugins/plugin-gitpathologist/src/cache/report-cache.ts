/**
 * On-disk cache for {@link PathologyReport}s.
 *
 * Layout: `<cacheDir>/<sha256(surface + since)>.json`.
 *
 * The cache stores the HEAD sha at analysis time. A subsequent run with a
 * different HEAD is treated as a miss — incremental splice is a v2 goal, not
 * needed for the first-pass "fast repeat call" win.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { CachedReportSummary, PathologyReport } from "../types.ts";

export interface CacheKeyInput {
  surface: string;
  since: string;
}

export function makeCacheKey(input: CacheKeyInput): string {
  return createHash("sha256").update(`${input.surface}\0${input.since}`).digest("hex");
}

export function defaultCacheDir(repoRoot: string): string {
  const override = process.env.GITPATHOLOGIST_CACHE_DIR?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(repoRoot, override);
  }
  return path.join(repoRoot, ".eliza", "gitpathology");
}

export function ensureCacheDir(cacheDir: string): void {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
}

export interface ReportCache {
  readonly dir: string;
  read(key: string): PathologyReport | null;
  write(report: PathologyReport): void;
  list(): CachedReportSummary[];
  isFreshFor(key: string, currentHeadSha: string): boolean;
}

export function createReportCache(cacheDir: string): ReportCache {
  ensureCacheDir(cacheDir);
  const pathFor = (key: string) => path.join(cacheDir, `${key}.json`);
  return {
    dir: cacheDir,
    read(key) {
      const file = pathFor(key);
      if (!existsSync(file)) return null;
      try {
        const raw = readFileSync(file, "utf8");
        return JSON.parse(raw) as PathologyReport;
      } catch {
        return null;
      }
    },
    write(report) {
      const file = pathFor(report.cacheKey);
      const tmp = path.join(cacheDir, `.${report.cacheKey}.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(tmp, JSON.stringify(report, null, 2), "utf8");
      renameSync(tmp, file);
    },
    list() {
      if (!existsSync(cacheDir)) return [];
      const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
      const out: CachedReportSummary[] = [];
      for (const file of files) {
        try {
          const full = path.join(cacheDir, file);
          const stat = statSync(full);
          const raw = readFileSync(full, "utf8");
          const report = JSON.parse(raw) as PathologyReport;
          out.push({
            cacheKey: report.cacheKey,
            surface: report.surface,
            generatedAt: report.generatedAt,
            headSha: report.headSha,
            commitCount: report.commitCount,
            sizeBytes: stat.size,
          });
        } catch {
          // error-policy:J3 untrusted-input sanitizing — the cache dir is a
          // regenerable, HEAD-keyed scratch store; a truncated/corrupt entry is
          // skipped from the listing rather than failing the whole `list()`.
        }
      }
      return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    },
    isFreshFor(key, currentHeadSha) {
      const cached = this.read(key);
      return cached?.headSha === currentHeadSha;
    },
  };
}
