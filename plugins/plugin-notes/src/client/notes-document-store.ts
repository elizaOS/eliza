import type { NotesOperation } from "./notes-contract.ts";
import {
  type NoteRecord,
  NotesCommitUncertain,
  NotesStore,
} from "./notes-store.ts";

/** Host-owned opaque revision. Raw bytes retain the existing Notes envelope. */
export interface NotesDocumentSnapshot {
  revision: string;
  raw: string;
}
export class NotesDocumentConflict extends Error {}
export interface NotesDocumentPort {
  /** Call create only inside the host's atomic first-initialization boundary.
   * The host preserves legacy bytes and owns backup/reset policy. */
  initialize(
    create: (currentRaw: string | null, legacyRaw: string | null) => string,
    signal?: AbortSignal,
  ): Promise<NotesDocumentSnapshot>;
  read(signal?: AbortSignal): Promise<NotesDocumentSnapshot | null>;
  /** Throw NotesDocumentConflict for a definite, non-applied conflict. */
  compareExchange(
    expected: NotesDocumentSnapshot,
    raw: string,
    signal?: AbortSignal,
  ): Promise<NotesDocumentSnapshot>;
}
const keys = { current: "current", legacy: "legacy" };
function inner(
  raw: string | null,
  legacy: string | null = null,
  initial: NoteRecord[] | (() => NoteRecord[]) = [],
) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(keys.current, raw);
  if (legacy !== null) values.set(keys.legacy, legacy);
  return new NotesStore(
    keys,
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    initial,
  );
}
function snapshot(value: NotesDocumentSnapshot): NotesDocumentSnapshot {
  if (
    !value ||
    typeof value.revision !== "string" ||
    !value.revision ||
    typeof value.raw !== "string"
  )
    throw Error("Invalid Notes document receipt");
  return { revision: value.revision, raw: value.raw };
}
const equal = (a: NotesDocumentSnapshot | null, b: NotesDocumentSnapshot) =>
  a?.revision === b.revision && a.raw === b.raw;

/** Device-local Notes over an asynchronous atomic host port, without a writable
 * synchronous mirror. Optimistic drafts remain unavailable as agent targets until
 * their commits settle. This class does not grant account or encryption authority. */
export class DocumentNotesStore {
  private tail: Promise<void> = Promise.resolve();
  private fault: unknown;
  private activeOperation = false;
  private constructor(
    private port: NotesDocumentPort,
    private saved: NotesDocumentSnapshot,
    private inner: NotesStore,
  ) {}
  static async open(
    port: NotesDocumentPort,
    initial: NoteRecord[] | (() => NoteRecord[]) = [],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const saved = snapshot(
      await port.initialize(
        (raw, legacy) => inner(raw, legacy, initial).raw,
        signal,
      ),
    );
    signal?.throwIfAborted();
    const store = new DocumentNotesStore(port, saved, inner(saved.raw));
    await store.assertCurrent(signal);
    return store;
  }
  get raw() {
    return this.inner.raw;
  }
  get list() {
    return this.inner.list;
  }
  get needsRecovery() {
    return this.fault !== undefined;
  }
  private check() {
    if (this.fault !== undefined) throw this.fault;
  }
  async assertCurrent(signal?: AbortSignal) {
    const task = this.tail.then(async () => {
      this.check();
      signal?.throwIfAborted();
      const current = await this.port.read(signal);
      signal?.throwIfAborted();
      if (!equal(current, this.saved))
        throw new NotesDocumentConflict(
          "Notes changed in another view. Reopen before editing.",
        );
    });
    this.tail = task.catch((error) => {
      this.fault = error;
    });
    return task;
  }
  private commit(raw: string, signal?: AbortSignal, authorized?: () => void) {
    const task = this.tail.then(async () => {
      this.check();
      signal?.throwIfAborted();
      if (raw === this.saved.raw) {
        if (!equal(await this.port.read(signal), this.saved))
          throw new NotesDocumentConflict(
            "Notes changed in another view. Reopen before editing.",
          );
        return;
      }
      authorized?.();
      let saved: NotesDocumentSnapshot;
      try {
        saved = snapshot(
          await this.port.compareExchange({ ...this.saved }, raw, signal),
        );
      } catch (error) {
        if (error instanceof NotesDocumentConflict) throw error;
        throw new NotesCommitUncertain(
          "Notes commit outcome is unknown. Reopen to inspect saved data before repeating the edit.",
        );
      }
      if (saved.raw !== raw || saved.revision === this.saved.revision)
        throw new NotesCommitUncertain(
          "Notes commit receipt changed. Reopen to inspect saved data.",
        );
      let current: NotesDocumentSnapshot | null;
      try {
        current = await this.port.read(signal);
      } catch {
        throw new NotesCommitUncertain(
          "Notes saved acknowledgement could not be verified. Do not repeat the edit.",
        );
      }
      if (!equal(current, saved))
        throw new NotesCommitUncertain(
          "Notes changed during saved readback. Inspect saved data before another edit.",
        );
      this.saved = saved;
    });
    this.tail = task.catch((error) => {
      this.fault = error;
    });
    return task;
  }
  replace(list: NoteRecord[]) {
    this.check();
    if (this.activeOperation)
      throw Error("Finish the approved Notes operation first.");
    this.inner.replace(list);
    return this.commit(this.inner.raw);
  }
  async target(id: string) {
    await this.assertCurrent();
    const raw = this.raw,
      target = await this.inner.target(id);
    await this.assertCurrent();
    if (raw !== this.raw) throw Error("Selected note changed");
    return target;
  }
  async execute(
    op: NotesOperation,
    id: string,
    signal: AbortSignal,
    authorized: () => void,
  ) {
    this.check();
    if (this.activeOperation)
      throw Error("Another Notes operation is in progress");
    this.activeOperation = true;
    try {
      await this.assertCurrent(signal);
      signal.throwIfAborted();
      authorized();
      const before = this.raw,
        result = await this.inner.execute(op, id, signal, authorized);
      if (this.raw !== before) await this.commit(this.raw, signal, authorized);
      else await this.assertCurrent(signal);
      signal.throwIfAborted();
      authorized();
      return result;
    } finally {
      this.activeOperation = false;
    }
  }
}
