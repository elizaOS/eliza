// Monotonic signed-release sequence state with atomic file replacement.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export const RELEASE_SEQUENCE_STATE_PATH_ENV =
  "ELIZAOS_RELEASE_SEQUENCE_STATE_PATH";

export interface ReleaseSequenceStore {
  /** Atomically reject rollback or persist the maximum accepted sequences. */
  accept(sequences: Readonly<Record<string, number>>): Promise<void>;
}

interface SequenceStateFile {
  schemaVersion: 1;
  sequences: Record<string, number>;
}

const sequenceKeyPattern = /^(stable|beta|nightly)\/(x86_64|arm64|riscv64)$/;

function validateSequences(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Release sequence state must be an object.");
  }
  const state = value as Partial<SequenceStateFile>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.sequences !== "object" ||
    state.sequences === null ||
    Array.isArray(state.sequences) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "sequences"].includes(key),
    )
  ) {
    throw new Error("Release sequence state schema is unsupported.");
  }
  const result: Record<string, number> = {};
  for (const [key, sequence] of Object.entries(state.sequences)) {
    if (
      !sequenceKeyPattern.test(key) ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0
    ) {
      throw new Error(`Release sequence state contains invalid entry ${key}.`);
    }
    result[key] = sequence;
  }
  return result;
}

export class FileReleaseSequenceStore implements ReleaseSequenceStore {
  private operation = Promise.resolve();

  constructor(private readonly statePath: string) {
    if (!path.isAbsolute(statePath)) {
      throw new Error("Release sequence state path must be absolute.");
    }
  }

  accept(sequences: Readonly<Record<string, number>>): Promise<void> {
    const operation = this.operation.then(() => this.acceptLocked(sequences));
    this.operation = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<Record<string, number>> {
    try {
      const stat = await fs.lstat(this.statePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Release sequence state path is not a regular file.");
      }
      const raw = await fs.readFile(this.statePath, "utf8");
      return validateSequences(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (error instanceof SyntaxError) {
        throw new Error("Release sequence state is corrupt JSON.");
      }
      throw error;
    }
  }

  private async acceptLocked(
    candidates: Readonly<Record<string, number>>,
  ): Promise<void> {
    const directory = path.dirname(this.statePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.statePath}.lock`;
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          "Release sequence state is locked by another installer process; retry after it exits.",
        );
      }
      throw error;
    }
    try {
      await this.acceptWithFileLock(candidates, directory);
    } finally {
      await fs.rmdir(lockPath);
    }
  }

  private async acceptWithFileLock(
    candidates: Readonly<Record<string, number>>,
    directory: string,
  ): Promise<void> {
    const validatedCandidates = validateSequences({
      schemaVersion: 1,
      sequences: { ...candidates },
    });
    const current = await this.read();
    for (const [key, sequence] of Object.entries(validatedCandidates)) {
      const previous = current[key];
      if (previous !== undefined && sequence < previous) {
        throw new Error(
          `Signed release rollback rejected for ${key}: sequence ${sequence} is below accepted sequence ${previous}.`,
        );
      }
    }
    const next = { ...current };
    let changed = false;
    for (const [key, sequence] of Object.entries(validatedCandidates)) {
      if ((next[key] ?? 0) < sequence) {
        next[key] = sequence;
        changed = true;
      }
    }
    if (!changed) return;

    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.statePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, sequences: next })}\n`,
        "utf8",
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.statePath);
      const directoryHandle = await fs.open(directory, "r");
      try {
        try {
          await directoryHandle.sync();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            process.platform !== "win32" ||
            !["EPERM", "EINVAL", "ENOTSUP"].includes(code ?? "")
          ) {
            throw error;
          }
          // Windows does not expose POSIX directory fsync. The file itself was
          // fsynced before the same-volume atomic rename above; all other
          // platforms and error codes remain fail-closed.
        }
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close();
      await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

export function configuredReleaseSequenceStore(
  env: NodeJS.ProcessEnv = process.env,
): ReleaseSequenceStore {
  const statePath = env[RELEASE_SEQUENCE_STATE_PATH_ENV];
  if (!statePath) {
    throw new Error(
      `Missing rollback state: ${RELEASE_SEQUENCE_STATE_PATH_ENV} is required. Release discovery is disabled.`,
    );
  }
  return new FileReleaseSequenceStore(statePath);
}
