/**
 * Atomic JSON read/write helpers (node-only).
 *
 * Consolidates the write-tmp + rename pattern duplicated across the agent
 * package for tokens, ledgers, config snapshots, and runtime operations.
 *
 * Defaults:
 *   - mode 0o600 on the written file (secret-grade)
 *   - dir mode 0o700 when the parent has to be created
 *   - JSON 2-space indent, no trailing newline
 *   - tmp filename `${filePath}.tmp-${pid}-${Date.now()}` (multi-process safe)
 *   - parent directory created with mkdir recursive
 *
 * On failure, the temp file is best-effort removed.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";

export interface WriteJsonAtomicOptions {
  /** File mode for the final file. Default 0o600. */
  mode?: number;
  /** Directory mode if the parent has to be created. Default 0o700. */
  dirMode?: number;
  /** Append a trailing newline. Default false. */
  trailingNewline?: boolean;
  /** `space` arg passed to JSON.stringify. Default 2. */
  indent?: number | string;
  /** Skip mkdir of the parent directory. Default false. */
  skipMkdir?: boolean;
}

interface NormalizedWriteOptions {
  mode: number;
  dirMode: number;
  trailingNewline: boolean;
  indent: number | string;
  skipMkdir: boolean;
}

function normalizeOptions(
  opts: WriteJsonAtomicOptions | undefined,
): NormalizedWriteOptions {
  return {
    mode: opts?.mode ?? 0o600,
    dirMode: opts?.dirMode ?? 0o700,
    trailingNewline: opts?.trailingNewline ?? false,
    indent: opts?.indent ?? 2,
    skipMkdir: opts?.skipMkdir ?? false,
  };
}

function tmpPathFor(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now()}`;
}

function serialize(value: unknown, opts: NormalizedWriteOptions): string {
  const body = JSON.stringify(value, null, opts.indent);
  return opts.trailingNewline ? `${body}\n` : body;
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts?: WriteJsonAtomicOptions,
): Promise<void> {
  const o = normalizeOptions(opts);
  if (!o.skipMkdir) {
    await fsp.mkdir(path.dirname(filePath), {
      recursive: true,
      mode: o.dirMode,
    });
  }
  const tmp = tmpPathFor(filePath);
  try {
    await fsp.writeFile(tmp, serialize(value, o), {
      encoding: "utf-8",
      mode: o.mode,
    });
    await fsp.rename(tmp, filePath);
  } finally {
    try {
      await fsp.rm(tmp, { force: true });
    } catch (error) {
      // error-policy:J6 best-effort teardown — a stranded temporary file is
      // observable but must not mask the original write/rename failure.
      logger.warn({
        file: tmp,
        error: error instanceof Error ? error.message : String(error),
      }, "[AtomicJson] Failed to remove temporary file");
    }
  }
}

export function writeJsonAtomicSync(
  filePath: string,
  value: unknown,
  opts?: WriteJsonAtomicOptions,
): void {
  const o = normalizeOptions(opts);
  if (!o.skipMkdir) {
    fs.mkdirSync(path.dirname(filePath), {
      recursive: true,
      mode: o.dirMode,
    });
  }
  const tmp = tmpPathFor(filePath);
  try {
    fs.writeFileSync(tmp, serialize(value, o), {
      encoding: "utf-8",
      mode: o.mode,
    });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (error) {
      // error-policy:J6 best-effort teardown — see the asynchronous path above.
      logger.warn({
        file: tmp,
        error: error instanceof Error ? error.message : String(error),
      }, "[AtomicJson] Failed to remove temporary file");
    }
  }
}

/**
 * Read and parse JSON. Only a genuinely absent file returns `null`; malformed
 * JSON and filesystem failures surface to the caller.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
