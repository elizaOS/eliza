/**
 * Bounded local-file and deterministic shard I/O for Telegram Desktop corpus
 * imports. This boundary rejects symlinked inputs and collector-owned output
 * targets, ignores every media path embedded in the export, and changes only
 * byte-different or stale Telegram shards.
 */
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type { CorpusMessage } from "../schema.ts";

export interface TelegramShardWriteStats {
  written: number;
  reused: number;
  removed: number;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OWNED_SHARD_NAME = /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/;
const OUTPUT_LOCK_NAME = ".telegram-desktop-collector.lock";

interface DirectoryGuard {
  directory: string;
  location: string;
  handle: FileHandle;
  device: number;
  inode: number;
}

function inputError(
  code: string,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, { code, context, cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readTelegramDesktopJson(
  exportPath: string,
  maxInputBytes: number,
): Promise<unknown> {
  if (path.basename(exportPath) !== "result.json") {
    throw inputError(
      "TELEGRAM_EXPORT_BAD_PATH",
      "Telegram Desktop input must be named result.json",
      { fileName: path.basename(exportPath) },
    );
  }
  let input: Awaited<ReturnType<typeof fs.open>>;
  try {
    input = await fs.open(
      exportPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    // error-policy:J2 open the untrusted path without following a final symlink.
    throw inputError(
      "TELEGRAM_EXPORT_BAD_PATH",
      "Telegram Desktop input could not be opened safely",
      { exportPath },
      error,
    );
  }
  let bytes: Buffer;
  try {
    const entry = await input.stat();
    if (!entry.isFile()) {
      throw inputError(
        "TELEGRAM_EXPORT_BAD_PATH",
        "Telegram Desktop input must be a regular, non-symlink file",
        { exportPath },
      );
    }
    if (entry.size > maxInputBytes) {
      throw inputError(
        "TELEGRAM_EXPORT_INPUT_TOO_LARGE",
        `Telegram Desktop input exceeds ${maxInputBytes} bytes`,
        { maxInputBytes },
      );
    }
    const boundedBytes = Buffer.allocUnsafe(maxInputBytes + 1);
    let totalBytes = 0;
    while (totalBytes < boundedBytes.byteLength) {
      const { bytesRead } = await input.read(
        boundedBytes,
        totalBytes,
        boundedBytes.byteLength - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    bytes = boundedBytes.subarray(0, totalBytes);
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 wrap input read failures without fabricating an empty export.
    throw inputError(
      "TELEGRAM_EXPORT_READ_FAILED",
      "Telegram Desktop input could not be read",
      { exportPath },
      error,
    );
  } finally {
    await input.close();
  }
  if (bytes.byteLength > maxInputBytes) {
    throw inputError(
      "TELEGRAM_EXPORT_INPUT_TOO_LARGE",
      `Telegram Desktop input exceeds ${maxInputBytes} bytes`,
      { maxInputBytes },
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    // error-policy:J2 wrap untrusted Telegram JSON with a typed boundary error.
    throw inputError(
      "TELEGRAM_EXPORT_BAD_JSON",
      "Telegram Desktop result.json is not valid JSON",
      { exportPath },
      error,
    );
  }
}

async function openDirectoryGuard(
  directory: string,
  location: string,
): Promise<DirectoryGuard> {
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    const noFollowDirectoryFlags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    handle = await fs.open(directory, noFollowDirectoryFlags);
  } catch (error) {
    // error-policy:J2 bind output inspection failures to the collector boundary.
    throw inputError(
      "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
      `${location} could not be opened safely`,
      { location },
      error,
    );
  }
  try {
    const entry = await handle.stat();
    if (!entry.isDirectory()) {
      throw inputError(
        "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
        `${location} must be a regular directory`,
        { location },
      );
    }
    if (process.platform !== "win32") {
      await handle.chmod(PRIVATE_DIRECTORY_MODE);
    }
    return {
      directory,
      location,
      handle,
      device: entry.dev,
      inode: entry.ino,
    };
  } catch (error) {
    await handle.close();
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 preserve output-inspection context and its filesystem cause.
    throw inputError(
      "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
      `${location} could not be secured`,
      { location },
      error,
    );
  }
}

async function assertDirectoryIdentity(guard: DirectoryGuard): Promise<void> {
  try {
    const entry = await fs.lstat(guard.directory);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      entry.dev !== guard.device ||
      entry.ino !== guard.inode
    ) {
      throw inputError(
        "TELEGRAM_EXPORT_OUTPUT_CHANGED",
        `${guard.location} changed while Telegram output was being written`,
        { location: guard.location },
      );
    }
    const heldEntry = await guard.handle.stat();
    if (
      !heldEntry.isDirectory() ||
      heldEntry.dev !== guard.device ||
      heldEntry.ino !== guard.inode
    ) {
      throw inputError(
        "TELEGRAM_EXPORT_OUTPUT_CHANGED",
        `${guard.location} no longer matches its validated directory handle`,
        { location: guard.location },
      );
    }
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 reject output replacement instead of following its new path.
    throw inputError(
      "TELEGRAM_EXPORT_OUTPUT_CHANGED",
      `${guard.location} could not be revalidated during Telegram output`,
      { location: guard.location },
      error,
    );
  }
}

async function closeDirectoryGuard(guard: DirectoryGuard): Promise<void> {
  try {
    await guard.handle.close();
  } catch (error) {
    // error-policy:J2 a guard-close failure makes output completion indeterminate.
    throw inputError(
      "TELEGRAM_EXPORT_WRITE_FAILED",
      `${guard.location} validation handle could not be closed`,
      { location: guard.location },
      error,
    );
  }
}

async function readExistingRegularFile(
  filePath: string,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // error-policy:J3 a missing output is the explicit fresh-run state.
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw inputError(
      "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
      "collector output target could not be opened safely",
      { filePath },
      error,
    );
  }
  try {
    const entry = await handle.stat();
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw inputError(
        "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
        "collector output target must be a regular file",
        { filePath },
      );
    }
    if (process.platform !== "win32") {
      await handle.chmod(PRIVATE_FILE_MODE);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 preserve output-read context and its filesystem cause.
    throw inputError(
      "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
      "collector output target could not be inspected",
      { filePath },
      error,
    );
  } finally {
    await handle.close();
  }
}

async function writeAtomicTextIfChanged(
  filePath: string,
  body: string,
  parent: DirectoryGuard,
): Promise<"written" | "reused"> {
  await assertDirectoryIdentity(parent);
  const existing = await readExistingRegularFile(filePath);
  await assertDirectoryIdentity(parent);
  if (existing === body) return "reused";
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let tempHandle: FileHandle | undefined;
  let installed = false;
  try {
    await assertDirectoryIdentity(parent);
    tempHandle = await fs.open(
      tempPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await tempHandle.writeFile(body, "utf8");
    await tempHandle.sync();
    await assertDirectoryIdentity(parent);
    await fs.rename(tempPath, filePath);
    installed = true;
    await assertDirectoryIdentity(parent);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await tempHandle?.truncate(0);
      await tempHandle?.sync();
    } catch (truncateError) {
      cleanupError = truncateError;
    }
    let identityError: unknown;
    try {
      await assertDirectoryIdentity(parent);
    } catch (changedError) {
      identityError = changedError;
    }
    if (!installed && !identityError) {
      try {
        await fs.unlink(tempPath);
      } catch (unlinkError) {
        if (!isRecord(unlinkError) || unlinkError.code !== "ENOENT") {
          cleanupError ??= unlinkError;
        }
      }
    }
    if (identityError && !cleanupError) throw identityError;
    if (cleanupError) {
      // error-policy:J2 preserve output and cleanup failures without retaining bytes.
      throw inputError(
        "TELEGRAM_EXPORT_WRITE_FAILED",
        "collector output failed and its temporary bytes could not be cleared",
        { filePath, tempPath },
        new AggregateError([error, cleanupError, identityError]),
      );
    }
    // error-policy:J2 preserve the atomic install failure after clearing bytes.
    throw inputError(
      "TELEGRAM_EXPORT_WRITE_FAILED",
      "collector output could not be installed atomically",
      { filePath },
      error,
    );
  } finally {
    await tempHandle?.close();
  }
  return "written";
}

/** Writes a collector-owned root artifact under a continuously held directory identity. */
export async function writeTelegramArtifact(
  filePath: string,
  body: string,
  assertAncestorIdentity: () => Promise<void>,
): Promise<"written" | "reused"> {
  await assertAncestorIdentity();
  const parent = await openDirectoryGuard(
    path.dirname(filePath),
    "Telegram corpus output directory",
  );
  try {
    const result = await writeAtomicTextIfChanged(filePath, body, parent);
    await assertAncestorIdentity();
    return result;
  } finally {
    await closeDirectoryGuard(parent);
  }
}

/**
 * Serializes one complete Telegram publication for an output root. The lock
 * fails closed instead of waiting, so a crashed or concurrent writer cannot
 * silently publish a mixed manifest, summary, and shard generation.
 */
export async function withTelegramOutputLock<T>(
  outDir: string,
  operation: (assertRootIdentity: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const root = await openDirectoryGuard(outDir, "outDir");
  const lockPath = path.join(outDir, OUTPUT_LOCK_NAME);
  let locked = false;
  try {
    await assertDirectoryIdentity(root);
    try {
      await fs.mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      locked = true;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        throw inputError(
          "TELEGRAM_EXPORT_OUTPUT_BUSY",
          "another Telegram collector owns this output directory",
          { outDir },
          error,
        );
      }
      // error-policy:J2 preserve unexpected lock acquisition failures.
      throw inputError(
        "TELEGRAM_EXPORT_WRITE_FAILED",
        "Telegram output lock could not be acquired",
        { outDir },
        error,
      );
    }
    await assertDirectoryIdentity(root);
    return await operation(() => assertDirectoryIdentity(root));
  } finally {
    try {
      if (locked) {
        await assertDirectoryIdentity(root);
        await fs.rmdir(lockPath);
        await assertDirectoryIdentity(root);
      }
    } finally {
      await closeDirectoryGuard(root);
    }
  }
}

function monthOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/** Writes the complete desired Telegram shard set and removes stale months. */
export async function writeTelegramShards(
  messages: CorpusMessage[],
  outDir: string,
  ownerAccountId: string,
): Promise<{ paths: string[]; stats: TelegramShardWriteStats }> {
  const outGuard = await openDirectoryGuard(outDir, "outDir");
  let platformGuard: DirectoryGuard | undefined;
  let shardGuard: DirectoryGuard | undefined;
  try {
    await assertDirectoryIdentity(outGuard);
    const platformDir = path.join(outDir, "telegram");
    platformGuard = await openDirectoryGuard(
      platformDir,
      "telegram output directory",
    );
    await assertDirectoryIdentity(outGuard);
    const shardDir = path.join(platformDir, ownerAccountId);
    shardGuard = await openDirectoryGuard(
      shardDir,
      "Telegram account output directory",
    );
    await assertDirectoryIdentity(platformGuard);

    const buckets = new Map<string, CorpusMessage[]>();
    for (const message of messages) {
      const month = monthOf(message.ts);
      const bucket = buckets.get(month) ?? [];
      bucket.push(message);
      buckets.set(month, bucket);
    }

    const stats: TelegramShardWriteStats = {
      written: 0,
      reused: 0,
      removed: 0,
    };
    const paths: string[] = [];
    const wantedNames = new Set<string>();
    for (const [month, bucket] of [...buckets.entries()].sort()) {
      bucket.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
      const fileName = `${month}.jsonl`;
      wantedNames.add(fileName);
      const shardPath = path.join(shardDir, fileName);
      const body = `${bucket.map((message) => JSON.stringify(message)).join("\n")}\n`;
      const outcome = await writeAtomicTextIfChanged(
        shardPath,
        body,
        shardGuard,
      );
      stats[outcome] += 1;
      paths.push(shardPath);
    }

    await assertDirectoryIdentity(shardGuard);
    const existingEntries = await fs.readdir(shardDir, { withFileTypes: true });
    await assertDirectoryIdentity(shardGuard);
    for (const entry of existingEntries) {
      if (!OWNED_SHARD_NAME.test(entry.name) || wantedNames.has(entry.name)) {
        continue;
      }
      const stalePath = path.join(shardDir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw inputError(
          "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
          "stale shard target must be a regular file",
          { stalePath },
        );
      }
      await assertDirectoryIdentity(shardGuard);
      await fs.unlink(stalePath);
      await assertDirectoryIdentity(shardGuard);
      stats.removed += 1;
    }
    return { paths, stats };
  } finally {
    if (shardGuard) await closeDirectoryGuard(shardGuard);
    if (platformGuard) await closeDirectoryGuard(platformGuard);
    await closeDirectoryGuard(outGuard);
  }
}
