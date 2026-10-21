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
 * PGlite it bundles). `PGLITE_INITDB_SNAPSHOT` may name another absolute path.
 * Only an empty in-memory database uses it; on-disk databases and callers that
 * already pass `loadDataDir` are left alone. Nothing here writes to disk.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGliteOptions } from "@electric-sql/pglite";

export const INITDB_SNAPSHOT_FILE = "pglite-initdb.bin";
/** An empty cluster is about 4 MB compressed; anything far larger is not one. */
export const MAX_INITDB_SNAPSHOT_BYTES = 64 * 1024 * 1024;

const isMemoryDataDir = (dataDir: unknown): boolean =>
  dataDir === undefined ||
  dataDir === null ||
  (typeof dataDir === "string" && dataDir.startsWith("memory://"));

/** The snapshot file to use for these options, or null. */
export function initdbSnapshotPath(
  options: PGliteOptions,
  env: Record<string, string | undefined> = process.env,
  bundleUrl: string = import.meta.url,
): string | null {
  const withData = options as PGliteOptions & {
    dataDir?: unknown;
    loadDataDir?: unknown;
  };
  if (withData.loadDataDir !== undefined) return null;
  if (!isMemoryDataDir(withData.dataDir)) return null;
  const configured = env.PGLITE_INITDB_SNAPSHOT?.trim();
  if (configured) return isAbsolute(configured) ? configured : null;
  try {
    return fileURLToPath(new URL(`./${INITDB_SNAPSHOT_FILE}`, bundleUrl));
  } catch {
    return null;
  }
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
  },
): Blob | null {
  if (!path) return null;
  const bytes = size(path);
  if (bytes === null || bytes < 2 || bytes > MAX_INITDB_SNAPSHOT_BYTES) return null;
  const data = read(path);
  // gzip magic: a file that is not a gzip archive is not a snapshot.
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) return null;
  return new Blob([data], { type: "application/x-gzip" });
}
