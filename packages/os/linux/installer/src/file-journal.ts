import { constants } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type InstallJournal, InstallRecoveryRequiredError } from "./executor";
import { openTrustedInstallDirectory } from "./trusted-directory";
import type { InstallJournalEntry } from "./types";

const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const OWNER_FILE_MODE = 0o600;

function recoveryRequired(
  message: string,
  cause?: unknown,
): InstallRecoveryRequiredError {
  const error = new InstallRecoveryRequiredError(`Install journal: ${message}`);
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function withCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw recoveryRequired(
        "operation and cleanup both failed; explicit recovery is required.",
        new AggregateError([error, cleanupError]),
      );
    }
    throw error;
  }
  await cleanup();
  return result;
}

function operatingUid(): number {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw recoveryRequired("Linux effective-user identity is unavailable.");
  }
  return uid;
}

function descriptorPath(handle: FileHandle, name?: string): string {
  const base = `/proc/self/fd/${handle.fd}`;
  return name === undefined ? base : `${base}/${name}`;
}

export class DurableFileInstallJournal implements InstallJournal {
  readonly directory: string;

  constructor(directory: string) {
    if (!directory.trim() || !isAbsolute(directory)) {
      throw new Error("Install journal directory must be an absolute path.");
    }
    this.directory = resolve(directory);
  }

  private names(planId: string): { journal: string; lock: string } {
    if (!PLAN_ID_PATTERN.test(planId)) {
      throw recoveryRequired("plan ID is not a canonical SHA-256 digest.");
    }
    return {
      journal: `${planId}.jsonl`,
      lock: `${planId}.lock`,
    };
  }

  private async acquireLock(
    directory: FileHandle,
    lockName: string,
  ): Promise<void> {
    let lock: FileHandle;
    try {
      lock = await open(
        descriptorPath(directory, lockName),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        OWNER_FILE_MODE,
      );
    } catch (error) {
      throw recoveryRequired(
        "single-writer lock exists or could not be acquired; interrupted or concurrent access requires explicit recovery.",
        error,
      );
    }
    await withCleanup(
      async () => {
        const stats = await lock.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.uid !== operatingUid() ||
          (stats.mode & 0o777) !== OWNER_FILE_MODE
        ) {
          throw recoveryRequired(
            "single-writer lock is not an owner-only regular file with one link.",
          );
        }
        await lock.sync();
      },
      () => lock.close(),
    );
    await directory.sync();
  }

  private async releaseLock(
    directory: FileHandle,
    lockName: string,
  ): Promise<void> {
    try {
      await unlink(descriptorPath(directory, lockName));
      await directory.sync();
    } catch (error) {
      throw recoveryRequired(
        "single-writer lock cleanup was not durably completed; explicit recovery is required.",
        error,
      );
    }
  }

  private parseRecords(
    planId: string,
    serialized: string,
  ): InstallJournalEntry[] {
    if (!serialized) return [];
    if (!serialized.endsWith("\n")) {
      throw recoveryRequired("journal ends with a partial record.");
    }
    return serialized
      .slice(0, -1)
      .split("\n")
      .map((line, index) => {
        try {
          const entry = JSON.parse(line) as InstallJournalEntry;
          if (
            typeof entry !== "object" ||
            entry === null ||
            entry.planId !== planId
          ) {
            throw new Error("record identity mismatch");
          }
          return entry;
        } catch (error) {
          throw recoveryRequired(
            `record ${index} is invalid: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
      });
  }

  private async readHeld(
    directory: FileHandle,
    journalName: string,
    planId: string,
  ): Promise<InstallJournalEntry[]> {
    let handle: FileHandle;
    try {
      handle = await open(
        descriptorPath(directory, journalName),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw recoveryRequired(
        "journal file could not be opened without following links.",
        error,
      );
    }
    return withCleanup(
      async () => {
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.uid !== operatingUid() ||
          (stats.mode & 0o777) !== OWNER_FILE_MODE ||
          stats.size > MAX_JOURNAL_BYTES
        ) {
          throw recoveryRequired(
            "journal must be a bounded, owner-only regular file with one link.",
          );
        }
        return this.parseRecords(planId, await handle.readFile("utf8"));
      },
      () => handle.close(),
    );
  }

  async read(planId: string): Promise<InstallJournalEntry[]> {
    const names = this.names(planId);
    const directory = await openTrustedInstallDirectory(
      this.directory,
      recoveryRequired,
    );
    return withCleanup(
      async () => {
        await this.acquireLock(directory, names.lock);
        return withCleanup(
          () => this.readHeld(directory, names.journal, planId),
          () => this.releaseLock(directory, names.lock),
        );
      },
      () => directory.close(),
    );
  }

  async append(entry: InstallJournalEntry): Promise<void> {
    const names = this.names(entry.planId);
    let encoded: string;
    try {
      encoded = JSON.stringify(entry);
    } catch (error) {
      throw recoveryRequired(
        `record is not serializable: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    const serialized = Buffer.from(`${encoded}\n`, "utf8");
    if (serialized.length > 64 * 1024) {
      throw recoveryRequired("record exceeds the maximum atomic append size.");
    }

    const directory = await openTrustedInstallDirectory(
      this.directory,
      recoveryRequired,
    );
    await withCleanup(
      async () => {
        await this.acquireLock(directory, names.lock);
        let writeStarted = false;
        try {
          let journal: FileHandle;
          try {
            journal = await open(
              descriptorPath(directory, names.journal),
              constants.O_CREAT |
                constants.O_APPEND |
                constants.O_RDWR |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
              OWNER_FILE_MODE,
            );
          } catch (error) {
            throw recoveryRequired(
              "journal file could not be opened for append.",
              error,
            );
          }
          await withCleanup(
            async () => {
              const stats = await journal.stat();
              if (
                !stats.isFile() ||
                stats.nlink !== 1 ||
                stats.uid !== operatingUid() ||
                (stats.mode & 0o777) !== OWNER_FILE_MODE ||
                stats.size + serialized.length > MAX_JOURNAL_BYTES
              ) {
                throw recoveryRequired(
                  "journal append target is not a bounded, owner-only regular file with one link.",
                );
              }
              const existing = this.parseRecords(
                entry.planId,
                await journal.readFile("utf8"),
              );
              if (
                entry.sequence !== existing.length ||
                entry.previousDigest !== (existing.at(-1)?.digest ?? null)
              ) {
                throw recoveryRequired(
                  "record is stale against the journal head held by the writer lock.",
                );
              }
              writeStarted = true;
              const result = await journal.write(
                serialized,
                0,
                serialized.length,
                null,
              );
              if (result.bytesWritten !== serialized.length) {
                throw recoveryRequired(
                  "journal record was only partially appended.",
                );
              }
              await journal.sync();
            },
            () => journal.close(),
          );
          await directory.sync();
        } catch (error) {
          if (!writeStarted) {
            await withCleanup(
              async () => {
                throw error;
              },
              () => this.releaseLock(directory, names.lock),
            );
          }
          throw error;
        }
        await this.releaseLock(directory, names.lock);
      },
      () => directory.close(),
    );
  }
}
