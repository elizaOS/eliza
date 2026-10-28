/**
 * Device-local store for voice-note recordings in a browser host.
 *
 * Recording bytes and their transcript live in one IndexedDB object store keyed by
 * recording id. Each recording belongs to exactly one note. Deletion is two-phase
 * and owned by one deletion operation at a time: `changeAudioDeleted` moves a
 * recording to Trash or restores it, `purgeAudio` erases bytes and transcript of a
 * recording that operation trashed. Every step records a per-operation receipt so a
 * retried step is idempotent and a stale or foreign operation is refused. Trashed
 * recordings expire after the retention window; `migrateAudio` normalizes old rows
 * and erases expired ones. The host names the database so installed data keeps its
 * existing location.
 */

export type NotesAudioDeletionStatus = "removed" | "restored" | "purged";
export interface NotesAudioRow {
  audioId: string;
  noteId: string;
  durationMs: number;
  blob: Blob;
  bytes?: ArrayBuffer;
  transcript: string;
  createdAt: number;
  mimeType: string;
  deletedAt?: number;
  expired?: true;
  deletionOperations?: Record<string, NotesAudioDeletionStatus>;
  activeDeletionOperation?: string;
}
export type NotesAudioMetadata = Omit<NotesAudioRow, "blob" | "bytes">;
export interface NotesAudioReceipt {
  audioId: string;
  noteId: string;
  operationId: string;
  status: NotesAudioDeletionStatus | "unknown";
}
export interface NotesAudioMigration {
  state: "complete" | "needs-recovery";
  failedRecords: number;
}
export interface NotesAudioStoreOptions {
  /** IndexedDB database name owned by the host (kept stable for installed data). */
  databaseName: string;
  /** How long a trashed recording can be restored. Defaults to 30 days. */
  retentionMs?: number;
  /** IndexedDB factory; defaults to the global one. */
  indexedDB?: IDBFactory;
  now?: () => number;
}
export interface NotesAudioStore {
  retainAudio(
    audioId: string,
    noteId: string,
    transcript: string,
    clip?: { blob: Blob; durationMs: number },
  ): Promise<NotesAudioMetadata>;
  audioRecord(
    audioId: string,
    includeDeleted?: boolean,
  ): Promise<NotesAudioRow>;
  audioDeletionStatus(
    audioId: string,
    noteId: string,
    operation: string,
  ): Promise<NotesAudioReceipt>;
  changeAudioDeleted(
    audioId: string,
    noteId: string,
    deleted: boolean,
    operation: string,
  ): Promise<NotesAudioReceipt>;
  purgeAudio(
    audioId: string,
    noteId: string,
    operation: string,
  ): Promise<NotesAudioReceipt>;
  migrateAudio(): Promise<NotesAudioMigration>;
}

export const NOTES_AUDIO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const NOTES_AUDIO_TRANSCRIPT_LIMIT = 64_000;
export const NOTES_AUDIO_OPERATION_LIMIT = 128;
const STORE = "audio";
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const identity = (value: unknown) => {
  if (typeof value !== "string" || !value || value.length > 128)
    throw Error("Invalid recording identity.");
};
const operationId = (value: unknown) => {
  if (typeof value !== "string" || !OPERATION_ID.test(value))
    throw Error("Invalid deletion operation");
};

/** Recording metadata without its bytes, safe to keep in note records. */
export function notesAudioMetadata({
  blob: _blob,
  bytes: _bytes,
  ...metadata
}: NotesAudioRow): NotesAudioMetadata {
  return metadata;
}

export function createNotesAudioStore(
  options: NotesAudioStoreOptions,
): NotesAudioStore {
  if (typeof options?.databaseName !== "string" || !options.databaseName)
    throw Error("Notes audio store needs a database name.");
  const retention = options.retentionMs ?? NOTES_AUDIO_RETENTION_MS;
  const now = options.now ?? Date.now;
  let database: Promise<IDBDatabase> | undefined;

  const db = () => {
    database ??= new Promise((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      const request = factory.open(options.databaseName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE, { keyPath: "audioId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
    return database;
  };

  // biome-ignore lint/suspicious/noExplicitAny: rows read from storage are untrusted.
  const normalize = (input: any): NotesAudioRow => {
    let row = input;
    if (row?.bytes instanceof ArrayBuffer)
      row = {
        ...row,
        blob: new Blob([row.bytes], {
          type: row.mimeType || "application/octet-stream",
        }),
      };
    if (
      !row ||
      !(row.blob instanceof Blob) ||
      (!row.blob.size && !row.expired) ||
      !Number.isFinite(row.durationMs) ||
      row.durationMs <= 0
    )
      throw Error("Recording metadata needs recovery.");
    identity(row.audioId);
    identity(row.noteId);
    return {
      ...row,
      transcript: typeof row.transcript === "string" ? row.transcript : "",
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : now(),
      mimeType: row.blob.type || "application/octet-stream",
    };
  };
  /** Rows carrying bytes are stored without the Blob (structured-clone safe). */
  const stored = (row: NotesAudioRow) => {
    if (row.bytes instanceof ArrayBuffer) {
      const { blob: _blob, ...data } = row;
      return data;
    }
    return row;
  };
  const receipt = (
    row: NotesAudioRow,
    operation: string,
  ): NotesAudioReceipt => ({
    audioId: row.audioId,
    noteId: row.noteId,
    operationId: operation,
    status: row.deletionOperations?.[operation] || "unknown",
  });

  async function mutate<T>(
    audioId: string,
    edit: (row: NotesAudioRow | undefined, store: IDBObjectStore) => T,
  ): Promise<T> {
    identity(audioId);
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let result: T;
      let error: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () =>
        reject(
          error || tx.error || Error("Recording change could not be saved."),
        );
      const request = store.get(audioId);
      request.onsuccess = () => {
        try {
          const row = request.result ? normalize(request.result) : undefined;
          result = edit(row, store);
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
    });
  }

  return {
    async retainAudio(audioId, noteId, transcript, clip) {
      identity(noteId);
      if (
        typeof transcript !== "string" ||
        transcript.length > NOTES_AUDIO_TRANSCRIPT_LIMIT
      )
        throw Error("Transcript is too long.");
      const bytes = clip ? await clip.blob.arrayBuffer() : undefined;
      return mutate(audioId, (prior, store) => {
        if (prior && (prior.noteId !== noteId || prior.deletedAt))
          throw Error("This recording is not available for this note.");
        if (!prior && !clip) throw Error("Record a clip first.");
        const row = normalize(
          prior
            ? { ...prior, transcript }
            : {
                audioId,
                noteId,
                ...clip,
                bytes,
                mimeType: clip?.blob.type,
                transcript,
                createdAt: now(),
              },
        );
        if (prior) store.put(stored(row));
        else store.add(stored(row));
        return notesAudioMetadata(row);
      });
    },
    async audioRecord(audioId, includeDeleted = false) {
      return mutate(audioId, (row, store) => {
        if (!row) throw Error("Recording not found.");
        if (row.deletedAt && !includeDeleted)
          throw Error("Restore this recording before playing it.");
        store.put(stored(row));
        return row;
      });
    },
    async audioDeletionStatus(audioId, noteId, operation) {
      operationId(operation);
      return mutate(audioId, (row) => {
        if (!row || row.noteId !== noteId)
          throw Error("Recording owner changed");
        return receipt(row, operation);
      });
    },
    async changeAudioDeleted(audioId, noteId, deleted, operation) {
      identity(noteId);
      operationId(operation);
      return mutate(audioId, (row, store) => {
        if (!row || row.noteId !== noteId)
          throw Error("This recording belongs to another note.");
        const operations = row.deletionOperations || {};
        const prior = operations[operation];
        if (
          prior === "restored" ||
          (deleted && (prior === "removed" || prior === "purged"))
        )
          return receipt(row, operation);
        if (prior === "purged" || row.expired)
          throw Error("This recording has expired.");
        if (
          !prior &&
          Object.keys(operations).length >= NOTES_AUDIO_OPERATION_LIMIT
        )
          throw Error("Recording operation history full");
        const legacyRestore =
          !deleted &&
          !!row.deletedAt &&
          !("activeDeletionOperation" in row) &&
          !("deletionOperations" in row);
        if (
          row.deletedAt &&
          row.activeDeletionOperation !== operation &&
          !legacyRestore
        )
          throw Error("Another deletion owns recording");
        if (row.deletedAt && now() - row.deletedAt > retention)
          throw Error("This recording has expired.");
        if (deleted) {
          row.deletedAt = now();
          row.activeDeletionOperation = operation;
        } else {
          delete row.deletedAt;
          delete row.activeDeletionOperation;
        }
        operations[operation] = deleted ? "removed" : "restored";
        row.deletionOperations = operations;
        store.put(stored(row));
        return receipt(row, operation);
      });
    },
    async purgeAudio(audioId, noteId, operation) {
      identity(noteId);
      operationId(operation);
      return mutate(audioId, (row, store) => {
        if (!row || row.noteId !== noteId)
          throw Error("This recording belongs to another note.");
        const operations = row.deletionOperations || {};
        const prior = operations[operation];
        if (prior === "purged") return receipt(row, operation);
        if (
          prior !== "removed" ||
          !row.deletedAt ||
          row.activeDeletionOperation !== operation
        )
          throw Error("This recording is not in this deletion.");
        operations[operation] = "purged";
        store.put(
          stored({
            ...row,
            blob: new Blob([]),
            bytes: new ArrayBuffer(0),
            transcript: "",
            expired: true,
            deletionOperations: operations,
          }),
        );
        return {
          audioId: row.audioId,
          noteId: row.noteId,
          operationId: operation,
          status: "purged",
        };
      });
    },
    async migrateAudio() {
      const d = await db();
      return new Promise<NotesAudioMigration>((resolve, reject) => {
        const tx = d.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        let failedRecords = 0;
        tx.oncomplete = () =>
          resolve({
            state: failedRecords ? "needs-recovery" : "complete",
            failedRecords,
          });
        tx.onabort = tx.onerror = () =>
          reject(tx.error || Error("Recording metadata could not be updated."));
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          try {
            const row = normalize(cursor.value);
            if (row.deletedAt && now() - row.deletedAt > retention) {
              if (!row.deletionOperations) cursor.delete();
              else
                cursor.update(
                  stored({
                    ...row,
                    blob: new Blob([]),
                    bytes: new ArrayBuffer(0),
                    transcript: "",
                    expired: true,
                  }),
                );
            } else cursor.update(stored(row));
          } catch {
            failedRecords++;
          }
          cursor.continue();
        };
      });
    },
  };
}
