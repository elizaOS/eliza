/**
 * A pre-initialized, empty PGlite data directory for in-memory databases.
 *
 * PGlite runs `initdb` for every empty data directory. For that it creates a
 * second, temporary PGlite instance; PGlite 0.4.x keeps that instance's
 * WebAssembly memory alive after `close()`, so an in-memory database costs two
 * full Postgres heaps (about 184 MB each) for the life of the process. Starting
 * from a snapshot taken right after `initdb` skips the temporary instance
 * entirely, which matters on 4 GB phones and tablets.
 *
 * The mobile bundle build writes the snapshot next to the bundle as
 * `pglite-initdb.bin` (gzip tar from `dumpDataDir("gzip")`, made by the same
 * PGlite it bundles). It also writes `pglite-migrated.bin`, the same cluster
 * after the always-loaded plugin schemas are migrated (migrated-snapshot.ts);
 * when that file is beside the bundle it is preferred, so a boot skips the
 * migrations as well. `PGLITE_MIGRATED_SNAPSHOT=0` keeps the plain initdb one,
 * as does `ELIZA_PGLITE_DISABLE_EXTENSIONS=1` (the migrated cluster needs them).
 * A migrated file that is unreadable, too large or not gzip falls back to the
 * plain initdb snapshot beside it rather than to a full initdb.
 * `PGLITE_INITDB_SNAPSHOT` may name another absolute path, which wins over both.
 * Only an empty in-memory database uses it; on-disk databases and callers that
 * already pass `loadDataDir` are left alone. Nothing here writes to disk.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGliteOptions } from "@electric-sql/pglite";
import { isMemoryDataDir } from "./memory-settings";

export const INITDB_SNAPSHOT_FILE = "pglite-initdb.bin";
/** The pre-migrated cluster (migrated-snapshot.ts), preferred when present. */
export const MIGRATED_SNAPSHOT_FILE = "pglite-migrated.bin";
/** An empty cluster is about 4 MB compressed; anything far larger is not one. */
export const MAX_INITDB_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** The snapshot file to use for these options, or null. */
export function initdbSnapshotPath(
  options: PGliteOptions,
  env: Record<string, string | undefined> = process.env,
  bundleUrl: string = import.meta.url,
  isFile: (path: string) => boolean = defaultIsFile
): string | null {
  return initdbSnapshotCandidates(options, env, bundleUrl, isFile)[0] ?? null;
}

function defaultIsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The snapshot files to try for these options, in order: the migrated cluster
 * when it is beside the bundle and allowed, then the plain initdb one. An
 * explicit `PGLITE_INITDB_SNAPSHOT` is the only candidate.
 */
export function initdbSnapshotCandidates(
  options: PGliteOptions,
  env: Record<string, string | undefined> = process.env,
  bundleUrl: string = import.meta.url,
  isFile: (path: string) => boolean = defaultIsFile
): string[] {
  const withData = options as PGliteOptions & {
    dataDir?: unknown;
    loadDataDir?: unknown;
  };
  if (withData.loadDataDir !== undefined) return [];
  if (!isMemoryDataDir(withData.dataDir)) return [];
  const configured = env.PGLITE_INITDB_SNAPSHOT?.trim();
  if (configured) return isAbsolute(configured) ? [configured] : [];
  const candidates: string[] = [];
  try {
    // The migrated cluster records the vector, fuzzystrmatch and pg_trgm
    // extensions and has columns of their types, so it needs them loaded.
    if (
      env.PGLITE_MIGRATED_SNAPSHOT?.trim() !== "0" &&
      env.ELIZA_PGLITE_DISABLE_EXTENSIONS !== "1"
    ) {
      const migrated = fileURLToPath(new URL(`./${MIGRATED_SNAPSHOT_FILE}`, bundleUrl));
      if (isFile(migrated)) candidates.push(migrated);
    }
    candidates.push(fileURLToPath(new URL(`./${INITDB_SNAPSHOT_FILE}`, bundleUrl)));
  } catch {
    return candidates;
  }
  return candidates;
}

export interface InitdbSnapshot {
  path: string;
  blob: Blob;
  /** Candidates tried before this one and found unusable (absent, too large, not gzip). */
  skipped: string[];
}

/**
 * The first usable snapshot for these options, or null. A corrupt migrated
 * cluster falls back to the initdb one, so a bad file costs the migrations
 * and never the temporary initdb instance.
 */
export function loadInitdbSnapshot(
  options: PGliteOptions,
  env: Record<string, string | undefined> = process.env,
  bundleUrl: string = import.meta.url,
  isFile: (path: string) => boolean = defaultIsFile,
  read?: (path: string) => Uint8Array,
  size?: (path: string) => number | null
): InitdbSnapshot | null {
  const skipped: string[] = [];
  for (const path of initdbSnapshotCandidates(options, env, bundleUrl, isFile)) {
    const blob = readInitdbSnapshot(path, read, size);
    if (blob) return { path, blob, skipped };
    skipped.push(path);
  }
  return null;
}

/** Reads the snapshot as the `loadDataDir` blob PGlite expects, or null when absent or unusable. */
export function readInitdbSnapshot(
  path: string | null,
  read: (path: string) => Uint8Array = (file) => readFileSync(file),
  size: (path: string) => number | null = (file) => {
    try {
      const stat = statSync(file);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }
): Blob | null {
  if (!path) return null;
  const bytes = size(path);
  if (bytes === null || bytes < 2 || bytes > MAX_INITDB_SNAPSHOT_BYTES) return null;
  let data: Uint8Array;
  try {
    data = read(path);
  } catch {
    return null;
  }
  // gzip magic: a file that is not a gzip archive is not a snapshot.
  if (
    data.byteLength < 2 ||
    data.byteLength > MAX_INITDB_SNAPSHOT_BYTES ||
    data[0] !== 0x1f ||
    data[1] !== 0x8b
  )
    return null;
  // Copy only the view into an ArrayBuffer-backed array. A Buffer can point
  // into a larger pool; its backing buffer is not necessarily the payload.
  return new Blob([new Uint8Array(data)], { type: "application/x-gzip" });
}
