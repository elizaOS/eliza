/**
 * Atomic JSON persistence for the developer view workbench. One server-owned
 * document under the configured elizaOS state directory is the source of truth;
 * mutations are serialized in process, validated before publication, written
 * to a unique temporary file, and renamed over the durable file atomically.
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
  SIMPLE_VIEWS_SCHEMA_VERSION,
  type SimpleViewsDocument,
  type SimpleViewsSnapshot,
  type SimpleViewsStorePhase,
  type SimpleViewsStoreStatus,
} from "./types.js";
import { parseSimpleViewsDocument, todayDateKey } from "./validation.js";

export const SIMPLE_VIEWS_STATE_DIRECTORY = "simple-views";
export const SIMPLE_VIEWS_STATE_FILENAME = "state.json";

export interface SimpleViewsStoreOptions {
  filePath?: string;
  now?: () => Date;
}

export interface SimpleViewsTransaction<T> {
  value: T;
  snapshot: SimpleViewsSnapshot;
}

export function simpleViewsStateFilePath(stateDir = resolveStateDir()): string {
  return path.join(
    stateDir,
    SIMPLE_VIEWS_STATE_DIRECTORY,
    SIMPLE_VIEWS_STATE_FILENAME,
  );
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

  private readonly now: () => Date;
  private phase: SimpleViewsStorePhase = "idle";
  private document: SimpleViewsDocument | undefined;
  private failure: ElizaError | undefined;
  private initialization: Promise<void> | undefined;
  private writeBarrier: Promise<void> = Promise.resolve();

  constructor(options: SimpleViewsStoreOptions = {}) {
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : simpleViewsStateFilePath();
    this.now = options.now ? options.now : () => new Date();
  }

  getStatus(): SimpleViewsStoreStatus {
    const status: SimpleViewsStoreStatus = {
      phase: this.phase,
      filePath: this.filePath,
    };
    if (this.document) status.revision = this.document.revision;
    if (this.failure) {
      status.error = {
        code: this.failure.code,
        message: this.failure.message,
      };
    }
    return status;
  }

  async initialize(): Promise<void> {
    if (this.phase === "ready") return;
    if (this.phase === "error" && this.failure) throw this.failure;
    if (this.phase === "loading" && this.initialization) {
      await this.initialization;
      return;
    }

    this.phase = "loading";
    this.failure = undefined;
    this.initialization = this.load();
    try {
      await this.initialization;
    } catch (error) {
      // error-policy:J2 context-adding rethrow — callers need the durable file
      // path and a stable store code while preserving the original fs/JSON cause.
      const failure = toStoreError(
        error,
        "SIMPLE_VIEWS_STORE_LOAD_FAILED",
        "Simple Views state could not be loaded.",
        this.filePath,
      );
      this.failure = failure;
      this.phase = "error";
      throw failure;
    } finally {
      this.initialization = undefined;
    }
  }

  snapshot(): SimpleViewsSnapshot {
    return snapshotFromDocument(this.requireReadyDocument());
  }

  async transact<T>(
    mutate: (draft: SimpleViewsDocument) => T,
  ): Promise<SimpleViewsTransaction<T>> {
    await this.initialize();
    return this.serialize(async () => {
      const current = this.requireReadyDocument();
      const draft = cloneDocument(current);
      const value = mutate(draft);
      draft.revision = current.revision + 1;
      draft.persistedAt = this.now().toISOString();
      const next = parseSimpleViewsDocument(draft);
      await this.writeAtomic(next);
      this.document = next;
      return { value, snapshot: snapshotFromDocument(next) };
    });
  }

  async stop(): Promise<void> {
    await this.writeBarrier;
    this.document = undefined;
    this.failure = undefined;
    this.initialization = undefined;
    this.phase = "stopped";
  }

  private async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let document: SimpleViewsDocument;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // error-policy:J2 context-adding rethrow — corrupt bytes are fatal and
        // must remain distinguishable from an intentionally empty first boot.
        throw new ElizaError("Simple Views state is not valid JSON.", {
          code: "SIMPLE_VIEWS_STORE_INVALID_JSON",
          cause: error,
          context: { filePath: this.filePath },
          severity: "fatal",
        });
      }
      document = parseSimpleViewsDocument(parsed);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      const now = this.now();
      document = {
        schemaVersion: SIMPLE_VIEWS_SCHEMA_VERSION,
        revision: 0,
        persistedAt: now.toISOString(),
        notes: [],
        events: [],
        selectedDate: todayDateKey(now),
      };
      await this.writeAtomic(document);
    }
    this.document = document;
    this.phase = "ready";
  }

  private requireReadyDocument(): SimpleViewsDocument {
    if (this.phase === "error" && this.failure) throw this.failure;
    if (this.phase !== "ready" || !this.document) {
      throw new ElizaError(
        `Simple Views state is ${this.phase}; a ready store is required.`,
        {
          code: "SIMPLE_VIEWS_STORE_UNAVAILABLE",
          context: { phase: this.phase, filePath: this.filePath },
          severity: "ephemeral",
        },
      );
    }
    return this.document;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeBarrier;
    let release!: () => void;
    this.writeBarrier = new Promise<void>((resolve) => {
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
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true });
      const handle = await fs.open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify(document, null, 2)}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      try {
        await fs.rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        // error-policy:J6 best-effort teardown — the primary atomic-write error
        // is thrown below; cleanup failure is diagnostic and must not replace it.
        logger.warn(
          {
            src: "plugin-simple-views",
            temporaryPath,
            cleanupError,
          },
          "[SimpleViewsStore] Failed to remove a temporary state file",
        );
      }
      const failure = toStoreError(
        error,
        "SIMPLE_VIEWS_STORE_WRITE_FAILED",
        "Simple Views state could not be written atomically.",
        this.filePath,
      );
      this.failure = failure;
      this.phase = "error";
      throw failure;
    }
  }
}
