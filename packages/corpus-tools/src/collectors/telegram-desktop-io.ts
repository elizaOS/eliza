/**
 * Bounded local-file and deterministic shard I/O for Telegram Desktop corpus
 * imports. This boundary rejects symlinked inputs and collector-owned output
 * targets, ignores every media path embedded in the export, and changes only
 * byte-different or stale Telegram shards.
 */
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
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
    bytes = await input.readFile();
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

async function ensureDirectory(
  directory: string,
  location: string,
): Promise<void> {
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
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 preserve output-inspection context and its filesystem cause.
    throw inputError(
      "TELEGRAM_EXPORT_BAD_OUTPUT_PATH",
      `${location} could not be secured`,
      { location },
      error,
    );
  } finally {
    await handle.close();
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

export async function writeAtomicTextIfChanged(
  filePath: string,
  body: string,
): Promise<"written" | "reused"> {
  const existing = await readExistingRegularFile(filePath);
  if (existing === body) return "reused";
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, body, {
    encoding: "utf8",
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // error-policy:J2 preserve the atomic-write cause after cleaning private bytes.
    try {
      await fs.unlink(tempPath);
    } catch (cleanupError) {
      // error-policy:J2 preserve both the install and cleanup causes.
      if (!isRecord(cleanupError) || cleanupError.code !== "ENOENT") {
        throw inputError(
          "TELEGRAM_EXPORT_WRITE_FAILED",
          "collector output failed and its temporary file could not be removed",
          { filePath, tempPath },
          new AggregateError([error, cleanupError]),
        );
      }
    }
    throw inputError(
      "TELEGRAM_EXPORT_WRITE_FAILED",
      "collector output could not be installed atomically",
      { filePath },
      error,
    );
  }
  return "written";
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
  await ensureDirectory(outDir, "outDir");
  const platformDir = path.join(outDir, "telegram");
  await ensureDirectory(platformDir, "telegram output directory");
  const shardDir = path.join(platformDir, ownerAccountId);
  await ensureDirectory(shardDir, "Telegram account output directory");

  const buckets = new Map<string, CorpusMessage[]>();
  for (const message of messages) {
    const month = monthOf(message.ts);
    const bucket = buckets.get(month) ?? [];
    bucket.push(message);
    buckets.set(month, bucket);
  }

  const stats: TelegramShardWriteStats = { written: 0, reused: 0, removed: 0 };
  const paths: string[] = [];
  const wantedNames = new Set<string>();
  for (const [month, bucket] of [...buckets.entries()].sort()) {
    bucket.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const fileName = `${month}.jsonl`;
    wantedNames.add(fileName);
    const shardPath = path.join(shardDir, fileName);
    const body = `${bucket.map((message) => JSON.stringify(message)).join("\n")}\n`;
    const outcome = await writeAtomicTextIfChanged(shardPath, body);
    stats[outcome] += 1;
    paths.push(shardPath);
  }

  for (const entry of await fs.readdir(shardDir, { withFileTypes: true })) {
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
    await fs.unlink(stalePath);
    stats.removed += 1;
  }
  return { paths, stats };
}
