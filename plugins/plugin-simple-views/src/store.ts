/**
 * Atomic JSON persistence for managed Cloud Notes and Calendar. Each agent owns a
 * document beneath the configured elizaOS state directory; duplicate service
 * instances share one in-process cache and write barrier for that file. Legacy
 * unscoped state is validated and copied once without replacing scoped data.
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
import { todayDateKey } from "./date-key.js";
import {
  SIMPLE_VIEWS_SCHEMA_VERSION,
  type SimpleViewsDocument,
  type SimpleViewsSnapshot,
  type SimpleViewsStorePhase,
  type SimpleViewsStoreStatus,
} from "./types.js";
import { parseSimpleViewsDocument } from "./validation.js";

export const SIMPLE_VIEWS_STATE_DIRECTORY = "simple-views";
export const SIMPLE_VIEWS_STATE_FILENAME = "state.json";

export function simpleViewsStateFilePath(
  stateDir = resolveStateDir(),
  agentId?: string,
): string {
  const scope = agentId?.trim();
  if (scope && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(scope)) {
    throw new ElizaError(
      "Simple Views agent id cannot be used as a state scope.",
      {
        code: "SIMPLE_VIEWS_INVALID_AGENT_SCOPE",
        context: { agentId },
        severity: "fatal",
      },
    );
  }
  return path.join(
    stateDir,
    SIMPLE_VIEWS_STATE_DIRECTORY,
    ...(scope ? ["agents", scope] : []),
    SIMPLE_VIEWS_STATE_FILENAME,
  );
}

interface SharedStoreState {
  phase: SimpleViewsStorePhase;
  document: SimpleViewsDocument | undefined;
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

function cloneDocument(document: SimpleViewsDocument): SimpleViewsDocument {
  return {
    schemaVersion: document.schemaVersion,
    revision: document.revision,
    persistedAt: document.persistedAt,
    selectedDate: document.selectedDate,
    notes: document.notes.map((note) => ({ ...note })),
    events: document.events.map((event) => ({ ...event })),
  };
}

function snapshotFromDocument(
  document: SimpleViewsDocument,
): SimpleViewsSnapshot {
  return {
    revision: document.revision,
    selectedDate: document.selectedDate,
    notes: document.notes.map((note) => ({ ...note })),
    events: document.events.map((event) => ({ ...event })),
  };
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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

export class SimpleViewsStore {
  readonly filePath: string;

  private readonly legacyFilePath: string | undefined;
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
      : simpleViewsStateFilePath(options.stateDir, options.agentId);
    this.legacyFilePath =
      !options.filePath && options.agentId?.trim()
        ? simpleViewsStateFilePath(options.stateDir)
        : undefined;
    this.now = options.now ? options.now : () => new Date();
    this.shared = acquireSharedState(this.filePath);
  }

  getStatus(): SimpleViewsStoreStatus {
    const status: SimpleViewsStoreStatus = {
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
    this.shared.initialization = this.load();
    try {
      await this.shared.initialization;
    } catch (error) {
      // error-policy:J2 context-adding rethrow — callers need the durable file
      // path and a stable store code while preserving the original fs/JSON cause.
      const failure = toStoreError(
        error,
        "SIMPLE_VIEWS_STORE_LOAD_FAILED",
        "Simple Views state could not be loaded.",
        this.filePath,
      );
      this.shared.failure = failure;
      this.shared.phase = "error";
      throw failure;
    } finally {
      this.shared.initialization = undefined;
    }
  }

  snapshot(): SimpleViewsSnapshot {
    return snapshotFromDocument(this.requireReadyDocument());
  }

  async transact<T>(
    mutate: (draft: SimpleViewsDocument) => T,
  ): Promise<{ value: T; snapshot: SimpleViewsSnapshot }> {
    await this.initialize();
    return this.serialize(async () => {
      const current = this.requireReadyDocument();
      const draft = cloneDocument(current);
      const value = mutate(draft);
      draft.revision = current.revision + 1;
      draft.persistedAt = this.now().toISOString();
      const next = parseSimpleViewsDocument(draft);
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
    let document: SimpleViewsDocument;
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

  private async readDocument(filePath: string): Promise<SimpleViewsDocument> {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // error-policy:J2 context-adding rethrow — corrupt bytes are fatal and
      // must remain distinguishable from an intentionally empty first boot.
      throw new ElizaError("Simple Views state is not valid JSON.", {
        code: "SIMPLE_VIEWS_STORE_INVALID_JSON",
        cause: error,
        context: { filePath },
        severity: "fatal",
      });
    }
    return parseSimpleViewsDocument(parsed);
  }

  private async initializeMissingDocument(): Promise<SimpleViewsDocument> {
    let candidate: SimpleViewsDocument | undefined;
    if (this.legacyFilePath) {
      try {
        candidate = await this.readDocument(this.legacyFilePath);
      } catch (error) {
        // error-policy:J3 a missing optional legacy source is explicit absence;
        // corrupt or unreadable legacy state must still surface.
        if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      }
    }

    if (!candidate) {
      const now = this.now();
      candidate = {
        schemaVersion: SIMPLE_VIEWS_SCHEMA_VERSION,
        revision: 0,
        persistedAt: now.toISOString(),
        notes: [],
        events: [],
        selectedDate: todayDateKey(now),
      };
    }

    const installed = await this.writeAtomicIfAbsent(candidate);
    return installed ? candidate : this.readDocument(this.filePath);
  }

  private requireReadyDocument(): SimpleViewsDocument {
    this.assertActive();
    if (this.shared.phase === "error" && this.shared.failure) {
      throw this.shared.failure;
    }
    if (this.shared.phase !== "ready" || !this.shared.document) {
      throw new ElizaError(
        `Simple Views state is ${this.shared.phase}; a ready store is required.`,
        {
          code: "SIMPLE_VIEWS_STORE_UNAVAILABLE",
          context: { phase: this.shared.phase, filePath: this.filePath },
          severity: "ephemeral",
        },
      );
    }
    return this.shared.document;
  }

  private assertActive(): void {
    if (!this.stopped) return;
    throw new ElizaError("Simple Views store has stopped.", {
      code: "SIMPLE_VIEWS_STORE_UNAVAILABLE",
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

  private async writeAtomic(document: SimpleViewsDocument): Promise<void> {
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
    document: SimpleViewsDocument,
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
    document: SimpleViewsDocument,
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
          src: "plugin-simple-views",
          temporaryPath,
          cleanupError,
        },
        "[SimpleViewsStore] Failed to remove a temporary state file",
      );
    }
  }

  private writeFailure(error: unknown): ElizaError {
    const failure = toStoreError(
      error,
      "SIMPLE_VIEWS_STORE_WRITE_FAILED",
      "Simple Views state could not be written atomically.",
      this.filePath,
    );
    this.shared.failure = failure;
    this.shared.phase = "error";
    return failure;
  }
}
