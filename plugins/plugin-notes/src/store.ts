/**
 * Atomic JSON persistence for the managed Cloud Notes view. Each agent owns a
 * document beneath the configured elizaOS state directory; duplicate service
 * instances share one in-process cache and write barrier for that file. Missing
 * agent-scoped documents start empty and are installed without replacing data.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ElizaError,
  isElizaError,
  logger,
  resolveStateDir,
} from "@elizaos/core";
import {
  NOTES_SCHEMA_VERSION,
  type NotesDocument,
  type NotesSnapshot,
  type NotesStorePhase,
  type NotesStoreStatus,
} from "./types.js";
import { parseNotesDocument } from "./validation.js";

export const NOTES_STATE_DIRECTORY = "notes";
export const NOTES_STATE_FILENAME = "state.json";

export function notesStateFilePath(
  stateDir = resolveStateDir(),
  agentId?: string,
): string {
  const scope = agentId?.trim();
  if (scope && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(scope)) {
    throw new ElizaError(
      "Notes agent id cannot be used as a state scope.",
      {
        code: "NOTES_INVALID_AGENT_SCOPE",
        context: { agentId },
        severity: "fatal",
      },
    );
  }
  return path.join(
    stateDir,
    NOTES_STATE_DIRECTORY,
    ...(scope ? ["agents", scope] : []),
    NOTES_STATE_FILENAME,
  );
}

interface SharedStoreState {
  phase: NotesStorePhase;
  document: NotesDocument | undefined;
  failure: ElizaError | undefined;
  initialization: Promise<void> | undefined;
  writeBarrier: Promise<void>;
  references: number;
}

const sharedStoreStates = new Map<string, SharedStoreState>();

function acquireSharedState(filePath: string): SharedStoreState {
  const existing = sharedStoreStates.get(filePath);
  if (existing) {
    existing.references += 1;
    return existing;
  }
  const created: SharedStoreState = {
    phase: "idle",
    document: undefined,
    failure: undefined,
    initialization: undefined,
    writeBarrier: Promise.resolve(),
    references: 1,
  };
  sharedStoreStates.set(filePath, created);
  return created;
}

function cloneDocument(document: NotesDocument): NotesDocument {
  return {
    schemaVersion: document.schemaVersion,
    revision: document.revision,
    persistedAt: document.persistedAt,
    notes: document.notes.map((note) => ({ ...note })),
  };
}

function snapshotFromDocument(document: NotesDocument): NotesSnapshot {
  return {
    revision: document.revision,
    notes: document.notes.map((note) => ({ ...note })),
  };
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  // Filesystem errors can cross plugin/VM realms, where `instanceof Error`
  // does not preserve identity even though the Node error contract does.
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function toStoreError(
  error: unknown,
  code: string,
  message: string,
  filePath: string,
): ElizaError {
  if (isElizaError(error)) return error;
  return new ElizaError(message, {
    code,
    cause: error,
    context: { filePath },
    severity: "fatal",
  });
}

export class NotesStore {
  readonly filePath: string;

  private readonly now: () => Date;
  private readonly shared: SharedStoreState;
  private stopped = false;

  constructor(
    options: {
      filePath?: string;
      stateDir?: string;
      agentId?: string;
      now?: () => Date;
    } = {},
  ) {
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : notesStateFilePath(options.stateDir, options.agentId);
    this.now = options.now ? options.now : () => new Date();
    this.shared = acquireSharedState(this.filePath);
  }

  getStatus(): NotesStoreStatus {
    const status: NotesStoreStatus = {
      phase: this.stopped ? "stopped" : this.shared.phase,
      filePath: this.filePath,
    };
    if (!this.stopped && this.shared.document) {
      status.revision = this.shared.document.revision;
    }
    if (!this.stopped && this.shared.failure) {
      status.error = {
        code: this.shared.failure.code,
        message: this.shared.failure.message,
      };
    }
    return status;
  }

  async initialize(): Promise<void> {
    this.assertActive();
    if (this.shared.phase === "ready") return;
    if (this.shared.phase === "error" && this.shared.failure) {
      throw this.shared.failure;
    }
    if (this.shared.phase === "loading" && this.shared.initialization) {
      await this.shared.initialization;
      return;
    }

    this.shared.phase = "loading";
    this.shared.failure = undefined;
    const initialization = this.load().catch((error) => {
      // error-policy:J2 context-adding rethrow — every service instance sharing
      // this initialization must observe the same typed failure and cause.
      const failure = toStoreError(
        error,
        "NOTES_STORE_LOAD_FAILED",
        "Notes state could not be loaded.",
        this.filePath,
      );
      this.shared.failure = failure;
      this.shared.phase = "error";
      throw failure;
    });
    this.shared.initialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.shared.initialization === initialization) {
        this.shared.initialization = undefined;
      }
    }
  }

  snapshot(): NotesSnapshot {
    return snapshotFromDocument(this.requireReadyDocument());
  }

  async transact<T>(
    mutate: (draft: NotesDocument) => T,
  ): Promise<{ value: T; snapshot: NotesSnapshot }> {
    await this.initialize();
    return this.serialize(async () => {
      const current = this.requireReadyDocument();
      const draft = cloneDocument(current);
      const value = mutate(draft);
      draft.revision = current.revision + 1;
      draft.persistedAt = this.now().toISOString();
      const next = parseNotesDocument(draft);
      await this.writeAtomic(next);
      this.shared.document = next;
      return { value, snapshot: snapshotFromDocument(next) };
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.shared.writeBarrier;
    this.stopped = true;
    this.shared.references -= 1;
    if (this.shared.references > 0) return;
    this.shared.document = undefined;
    this.shared.failure = undefined;
    this.shared.initialization = undefined;
    this.shared.phase = "stopped";
    if (sharedStoreStates.get(this.filePath) === this.shared) {
      sharedStoreStates.delete(this.filePath);
    }
  }

  private async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let document: NotesDocument;
    try {
      document = await this.readDocument(this.filePath);
    } catch (error) {
      // error-policy:J3 ENOENT is the explicit first-boot signal; every other
      // filesystem or validation failure remains fatal.
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      document = await this.initializeMissingDocument();
    }
    this.shared.document = document;
    this.shared.phase = "ready";
  }

  private async readDocument(filePath: string): Promise<NotesDocument> {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // error-policy:J2 context-adding rethrow — corrupt bytes are fatal and
      // must remain distinguishable from an intentionally empty first boot.
      throw new ElizaError("Notes state is not valid JSON.", {
        code: "NOTES_STORE_INVALID_JSON",
        cause: error,
        context: { filePath },
        severity: "fatal",
      });
    }
    return parseNotesDocument(parsed);
  }

  private async initializeMissingDocument(): Promise<NotesDocument> {
    const now = this.now();
    const candidate: NotesDocument = {
      schemaVersion: NOTES_SCHEMA_VERSION,
      revision: 0,
      persistedAt: now.toISOString(),
      notes: [],
    };

    const installed = await this.writeAtomicIfAbsent(candidate);
    return installed ? candidate : this.readDocument(this.filePath);
  }

  private requireReadyDocument(): NotesDocument {
    this.assertActive();
    if (this.shared.phase === "error" && this.shared.failure) {
      throw this.shared.failure;
    }
    if (this.shared.phase !== "ready" || !this.shared.document) {
      throw new ElizaError(
        `Notes state is ${this.shared.phase}; a ready store is required.`,
        {
          code: "NOTES_STORE_UNAVAILABLE",
          context: { phase: this.shared.phase, filePath: this.filePath },
          severity: "ephemeral",
        },
      );
    }
    return this.shared.document;
  }

  private assertActive(): void {
    if (!this.stopped) return;
    throw new ElizaError("Notes store has stopped.", {
      code: "NOTES_STORE_UNAVAILABLE",
      context: { phase: "stopped", filePath: this.filePath },
      severity: "ephemeral",
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.shared.writeBarrier;
    let release!: () => void;
    this.shared.writeBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async writeAtomic(document: NotesDocument): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.writeTemporaryDocument(temporaryPath, document);
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      // error-policy:J2 preserve the atomic-write cause and add the store path.
      await this.removeTemporaryFile(temporaryPath);
      throw this.writeFailure(error);
    }
  }

  private async writeAtomicIfAbsent(
    document: NotesDocument,
  ): Promise<boolean> {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.writeTemporaryDocument(temporaryPath, document);
      try {
        // A hard link installs the fully fsynced inode in one step and fails
        // with EEXIST instead of replacing a scoped state created by a rival.
        await fs.link(temporaryPath, this.filePath);
        return true;
      } catch (error) {
        // error-policy:J3 EEXIST is an explicit concurrent-writer result; other
        // link failures must abort initialization.
        if (isNodeErrorWithCode(error, "EEXIST")) return false;
        throw error;
      }
    } catch (error) {
      // error-policy:J2 preserve the failed filesystem operation as the cause.
      throw this.writeFailure(error);
    } finally {
      await this.removeTemporaryFile(temporaryPath);
    }
  }

  private async writeTemporaryDocument(
    temporaryPath: string,
    document: NotesDocument,
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async removeTemporaryFile(temporaryPath: string): Promise<void> {
    try {
      await fs.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      // error-policy:J6 best-effort teardown — the primary atomic-write error
      // is thrown by the caller; cleanup failure must not replace it.
      logger.warn(
        {
          src: "plugin-notes",
          temporaryPath,
          cleanupError,
        },
        "[NotesStore] Failed to remove a temporary state file",
      );
    }
  }

  private writeFailure(error: unknown): ElizaError {
    const failure = toStoreError(
      error,
      "NOTES_STORE_WRITE_FAILED",
      "Notes state could not be written atomically.",
      this.filePath,
    );
    this.shared.failure = failure;
    this.shared.phase = "error";
    return failure;
  }
}
