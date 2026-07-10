/**
 * Signal Desktop corpus collector. Signal keeps ~years of history in a single
 * SQLCipher-encrypted `db.sqlite`; this collector resolves the database key
 * (config.json plaintext or Electron safeStorage via the Keychain), reads a
 * date-bounded slice of messages, normalizes them to the canonical corpus
 * schema, and writes idempotent month shards with a resume checkpoint.
 *
 * Safety invariants that make it publishable evidence:
 * - It never opens the live database. It copies `db.sqlite` into a local
 *   `.state` dir (outside git) and reads the copy read-only.
 * - The copy and the in-memory key are torn down in a `finally`, and teardown
 *   asserts the copy is gone — a failed wipe is a fail-closed error, not a
 *   warning, because a decrypted database copy must not outlive the run.
 * - The SQLCipher engine is injected (`openDatabase`) so the query/normalization
 *   path is tested against a real SQLite engine without shipping the native
 *   cipher, while the production default fails closed if the cipher is absent.
 *
 * Live decryption on the owner's machine (Keychain approval, real key) is the
 * only owner-gated step; everything here is exercised keyless in tests.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { CORPUS_CUTOFF_MS, type CorpusMessage } from "../schema.ts";
import {
  type CollectorCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from "./checkpoint.ts";
import { CollectorError } from "./errors.ts";
import { writeShards } from "./shard-writer.ts";
import {
  openSqlcipherDatabase,
  type SignalDatabaseOpener,
} from "./signal-db.ts";
import { type KeychainPasswordReader, resolveSignalKey } from "./signal-key.ts";
import { normalizeSignalRow, type SkipReason } from "./signal-normalize.ts";

export interface CollectSignalOptions {
  /** Signal install dir holding `config.json` and `sql/db.sqlite`. */
  signalDir: string;
  /** Corpus output root; shards land under `<outputDir>/signal/<accountId>/`. */
  outputDir: string;
  /** Local scratch dir for the db copy + checkpoints; never the git tree. */
  stateDir: string;
  accountId: string;
  ownerId: string;
  ownerDisplay: string;
  keychainService?: string;
  readKeychainPassword?: KeychainPasswordReader;
  /** SQLCipher opener; defaults to the native adapter. Injected in tests. */
  openDatabase?: SignalDatabaseOpener;
}

export interface CollectSignalResult {
  accountId: string;
  messagesAdded: number;
  messagesWritten: number;
  shardsWritten: number;
  shardPaths: string[];
  skipped: Record<SkipReason, number>;
  checkpoint: CollectorCheckpoint;
  dbCopyDeleted: boolean;
}

function emptySkipCounts(): Record<SkipReason, number> {
  return { "empty-body": 0, "before-cutoff": 0, "no-timestamp": 0 };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Copy the encrypted database to a private scratch path. Reading a copy — not
 * the live file — avoids racing Signal's own writers and keeps the source
 * untouched. Returns the copy path; the caller is responsible for teardown.
 */
async function copyDatabase(
  sourceDbPath: string,
  stateDir: string,
): Promise<string> {
  if (!(await pathExists(sourceDbPath))) {
    throw new CollectorError("Signal db.sqlite not found", {
      collectorCode: "source_missing",
      platform: "signal",
      context: { sourceDbPath },
    });
  }
  const scratch = await fs.mkdtemp(path.join(stateDir, "signal-db-"));
  const copyPath = path.join(scratch, "db.sqlite");
  await fs.copyFile(sourceDbPath, copyPath);
  return copyPath;
}

/**
 * Delete the database copy and its scratch dir, then assert it is gone. A
 * decrypted copy that survives the run is a data-exfiltration hazard, so a
 * failed wipe throws rather than logging and continuing.
 */
async function teardownCopy(copyPath: string): Promise<void> {
  await fs.rm(path.dirname(copyPath), { recursive: true, force: true });
  if (await pathExists(copyPath)) {
    throw new CollectorError(
      "Signal database copy still present after teardown",
      {
        collectorCode: "teardown_failed",
        platform: "signal",
        context: { copyPath },
      },
    );
  }
}

/**
 * Run one Signal collection pass. Resumes from the account checkpoint, pulls
 * messages at or after both the corpus cutoff and the last high-water mark,
 * normalizes and writes them, and advances the checkpoint to the newest message
 * written. Every exit path — success or failure — wipes the decrypted copy.
 */
export async function collectSignal(
  options: CollectSignalOptions,
): Promise<CollectSignalResult> {
  await fs.mkdir(options.stateDir, { recursive: true });

  const configPath = path.join(options.signalDir, "config.json");
  const sourceDbPath = path.join(options.signalDir, "sql", "db.sqlite");

  let keyHex = await resolveSignalKey({
    configPath,
    keychainService: options.keychainService,
    readKeychainPassword: options.readKeychainPassword,
  });

  const previous = await readCheckpoint(
    options.stateDir,
    "signal",
    options.accountId,
  );
  const cutoffMs = Math.max(CORPUS_CUTOFF_MS, previous?.lastTs ?? 0);

  const openDatabase = options.openDatabase ?? openSqlcipherDatabase;
  const copyPath = await copyDatabase(sourceDbPath, options.stateDir);

  try {
    const db = await openDatabase(copyPath, keyHex);
    const skipped = emptySkipCounts();
    const messages: CorpusMessage[] = [];
    try {
      for (const row of db.queryMessages(cutoffMs)) {
        const result = normalizeSignalRow(row, {
          accountId: options.accountId,
          ownerId: options.ownerId,
          ownerDisplay: options.ownerDisplay,
        });
        if (result.skipped) {
          skipped[result.skipped] += 1;
          continue;
        }
        if (result.message) messages.push(result.message);
      }
    } finally {
      db.close();
    }

    const summary = await writeShards(
      options.outputDir,
      "signal",
      options.accountId,
      messages,
    );

    const newestTs = messages.reduce((max, m) => Math.max(max, m.ts), 0);
    const newestId = messages
      .filter((m) => m.ts === newestTs)
      .map((m) => m.id)
      .sort()
      .at(-1);

    const checkpoint: CollectorCheckpoint = {
      platform: "signal",
      accountId: options.accountId,
      lastTs: Math.max(previous?.lastTs ?? 0, newestTs),
      lastId: newestId ?? previous?.lastId,
      messageCount: (previous?.messageCount ?? 0) + summary.messagesAdded,
      updatedAt: new Date().toISOString(),
    };
    await writeCheckpoint(options.stateDir, checkpoint);

    logger.info(
      `[SignalCollector] account=${options.accountId} added=${summary.messagesAdded} shards=${summary.shardsWritten} skipped=${JSON.stringify(skipped)}`,
    );

    return {
      accountId: options.accountId,
      messagesAdded: summary.messagesAdded,
      messagesWritten: summary.messagesWritten,
      shardsWritten: summary.shardsWritten,
      shardPaths: summary.paths,
      skipped,
      checkpoint,
      dbCopyDeleted: true,
    };
  } finally {
    // Wipe the decrypted copy and scrub the key from memory regardless of
    // outcome; teardown asserts the copy is gone.
    await teardownCopy(copyPath);
    keyHex = "";
  }
}

/** Default Signal install directory on macOS. */
export function defaultSignalDir(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "Signal");
}

/** Default local scratch/checkpoint dir for the collector. */
export function defaultSignalStateDir(): string {
  return path.join(tmpdir(), "eliza-corpus-signal-state");
}
