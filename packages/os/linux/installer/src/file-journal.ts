import { constants, type Stats } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type InstallJournal, InstallRecoveryRequiredError } from "./executor";
import type { InstallJournalEntry } from "./types";

const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

function recoveryRequired(message: string): InstallRecoveryRequiredError {
  return new InstallRecoveryRequiredError(`Install journal: ${message}`);
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

  /**
   * Walk through already-opened directory descriptors so an ancestor cannot
   * be swapped between validation and a child open. Journal children remain
   * anchored to the returned descriptor for the complete operation.
   */
  private async openTrustedDirectory(): Promise<FileHandle> {
    const flags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let current: FileHandle;
    try {
      current = await open("/", flags);
    } catch {
      throw recoveryRequired("could not open the filesystem root safely.");
    }
    try {
      const filesystemOwnerUid = (await current.stat()).uid;
      const components = this.directory.split("/").filter(Boolean);
      for (let index = 0; index < components.length; index += 1) {
        const component = components[index] as string;
        let next: FileHandle;
        try {
          next = await open(descriptorPath(current, component), flags);
        } catch {
          throw recoveryRequired(
            "a journal-path component could not be opened without following links.",
          );
        }
        const stats = await next.stat();
        const final = index === components.length - 1;
        try {
          this.assertTrustedDirectoryStats(stats, filesystemOwnerUid, final);
        } catch (error) {
          await next.close();
          throw error;
        }
        await current.close();
        current = next;
      }
      if (components.length === 0) {
        throw recoveryRequired(
          "directory must be a private service-owned directory below the filesystem root.",
        );
      }
      return current;
    } catch (error) {
      await current.close().catch(() => {});
      throw error;
    }
  }

  private assertTrustedDirectoryStats(
    stats: Stats,
    filesystemOwnerUid: number,
    final: boolean,
  ): void {
    const uid = operatingUid();
    const writableByOthers = (stats.mode & 0o022) !== 0;
    const trustedStickyDirectory =
      stats.isDirectory() &&
      stats.uid === filesystemOwnerUid &&
      (stats.mode & 0o1000) !== 0;
    if (
      !stats.isDirectory() ||
      (stats.uid !== uid && stats.uid !== filesystemOwnerUid) ||
      (writableByOthers && !trustedStickyDirectory)
    ) {
      throw recoveryRequired(
        "journal-path ancestors must be trusted real directories that cannot be replaced by another user.",
      );
    }
    if (
      final &&
      (stats.uid !== uid || (stats.mode & 0o777) !== OWNER_DIRECTORY_MODE)
    ) {
      throw recoveryRequired(
        "directory must be service-owned and inaccessible to group/other users.",
      );
    }
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
    } catch {
      throw recoveryRequired(
        "single-writer lock exists or could not be acquired; interrupted or concurrent access requires explicit recovery.",
      );
    }
    try {
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
    } finally {
      await lock.close();
    }
    await directory.sync();
  }

  private async releaseLock(
    directory: FileHandle,
    lockName: string,
  ): Promise<void> {
    try {
      await unlink(descriptorPath(directory, lockName));
      await directory.sync();
    } catch {
      throw recoveryRequired(
        "single-writer lock cleanup was not durably completed; explicit recovery is required.",
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
      );
    }
    try {
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
    } finally {
      await handle.close();
    }
  }

  async read(planId: string): Promise<InstallJournalEntry[]> {
    const names = this.names(planId);
    const directory = await this.openTrustedDirectory();
    try {
      await this.acquireLock(directory, names.lock);
      let result: InstallJournalEntry[] | undefined;
      let readError: unknown;
      try {
        result = await this.readHeld(directory, names.journal, planId);
      } catch (error) {
        readError = error;
      }
      await this.releaseLock(directory, names.lock);
      if (readError !== undefined) throw readError;
      if (result === undefined) {
        throw recoveryRequired("journal read did not reach a result.");
      }
      return result;
    } finally {
      await directory.close();
    }
  }

  async append(entry: InstallJournalEntry): Promise<void> {
    const names = this.names(entry.planId);
    let encoded: string;
    try {
      encoded = JSON.stringify(entry);
    } catch (error) {
      throw recoveryRequired(
        `record is not serializable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const serialized = Buffer.from(`${encoded}\n`, "utf8");
    if (serialized.length > 64 * 1024) {
      throw recoveryRequired("record exceeds the maximum atomic append size.");
    }

    const directory = await this.openTrustedDirectory();
    try {
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
        } catch {
          throw recoveryRequired(
            "journal file could not be opened for append.",
          );
        }
        try {
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
        } finally {
          await journal.close();
        }
        await directory.sync();
      } catch (error) {
        if (!writeStarted) {
          await this.releaseLock(directory, names.lock);
        }
        throw error;
      }
      await this.releaseLock(directory, names.lock);
    } finally {
      await directory.close();
    }
  }
}
