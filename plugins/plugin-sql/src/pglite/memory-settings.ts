/**
 * Postgres settings for an in-memory (`memory://`) PGlite database.
 *
 * PGlite's defaults suit a disk database: a 128 MB buffer pool and up to 1 GB
 * of WAL. In memory, every WAL segment and every data page is already a
 * WebAssembly file in RAM, so the buffer pool holds a second copy and the WAL
 * only costs memory. PGlite runs Postgres in single-user mode, which never
 * starts a checkpoint by itself, so the manager also runs one when the WAL
 * grows (see PGliteClientManager.runMemoryMaintenance).
 *
 * These settings are added after `PGlite.defaultStartParams`, never instead of
 * them: a caller's `startParams` replaces the defaults, and Postgres would
 * then start without single-user mode. `PGLITE_MEMORY_SETTINGS` adds or
 * overrides settings, for example `shared_buffers=32MB,max_wal_size=64MB`.
 */
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";

export const MEMORY_SETTINGS_ENV = "PGLITE_MEMORY_SETTINGS";

/** Nothing survives the process, so crash-safety WAL is not needed. */
export const DEFAULT_MEMORY_SETTINGS: Readonly<Record<string, string>> = {
  shared_buffers: "16MB",
  // 32 MB is the minimum: two 16 MB segments.
  max_wal_size: "32MB",
  min_wal_size: "32MB",
  full_page_writes: "off",
  wal_level: "minimal",
  // wal_level=minimal requires this.
  max_wal_senders: "0",
};

const SETTING = /^([a-z][a-z0-9_.]*)=([^\s,=]+)$/;

/** Parses `name=value` pairs separated by commas or spaces. */
export function parseMemorySettings(text: string | undefined): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const entry of (text ?? "").split(/[\s,]+/)) {
    if (!entry) continue;
    const match = SETTING.exec(entry);
    if (!match) {
      throw new Error(`${MEMORY_SETTINGS_ENV}: "${entry}" is not a name=value Postgres setting`);
    }
    settings[match[1]] = match[2];
  }
  return settings;
}

export const isMemoryDataDir = (dataDir: unknown): boolean =>
  dataDir === undefined ||
  dataDir === null ||
  (typeof dataDir === "string" && dataDir.startsWith("memory://"));

/**
 * The options with the in-memory settings added. Disk databases and callers
 * that pass their own `startParams` are returned unchanged.
 */
export function withMemorySettings(
  options: PGliteOptions,
  env: Record<string, string | undefined> = process.env
): PGliteOptions {
  if (options.startParams !== undefined) return options;
  if (!isMemoryDataDir((options as { dataDir?: unknown }).dataDir)) return options;
  const settings = { ...DEFAULT_MEMORY_SETTINGS, ...parseMemorySettings(env[MEMORY_SETTINGS_ENV]) };
  const extra = Object.entries(settings).flatMap(([name, value]) => ["-c", `${name}=${value}`]);
  return { ...options, startParams: [...PGlite.defaultStartParams, ...extra] };
}
