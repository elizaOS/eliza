import type { NotesOperation } from "./notes-contract.ts";
import {
  type NoteRecord,
  NotesCommitUncertain,
  type NotesStorageKeys,
  NotesStore,
} from "./notes-store.ts";

/** Snapshots must be JSON-serializable and include the persistence revision.
 * A null CAS result means conflict; a thrown write has an uncertain outcome.
 * The host owns initialization, migration and recovery, and must provide atomic CAS.
 */
export interface NotesPersistence<Snapshot> {
  read(): Promise<Snapshot | null>;
  raw(snapshot: Snapshot): string;
  compareExchange(
    expected: Snapshot,
    nextRaw: string,
    signal?: AbortSignal,
  ): Promise<Snapshot | null>;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The local snapshot supports rendering; only acknowledged CAS commits authorize results. */
export class AsyncNotesStore<Snapshot> {
  private tail: Promise<void> = Promise.resolve();
  private fault: unknown;
  private failed = false;
  private activeOperation = false;
  private inner: NotesStore;
  protected constructor(
    keys: NotesStorageKeys,
    private persistence: NotesPersistence<Snapshot>,
    private saved: Snapshot,
  ) {
    this.saved = structuredClone(saved);
    const current = keys.current;
    let raw = persistence.raw(saved);
    this.inner = new NotesStore(keys, {
      getItem: (key) => (key === current ? raw : null),
      setItem: (key, value) => {
        if (key !== current) throw Error("Unexpected Notes snapshot write");
        raw = value;
      },
    });
  }
  static async load<Snapshot>(
    keys: NotesStorageKeys,
    persistence: NotesPersistence<Snapshot>,
  ) {
    const saved = await persistence.read();
    if (saved === null)
      throw Error(
        "Notes document is missing. Initialize or recover it before opening.",
      );
    return new AsyncNotesStore(keys, persistence, saved);
  }
  get raw() {
    return this.inner.raw;
  }
  get list() {
    return this.inner.list;
  }
  get needsRecovery() {
    return this.failed;
  }
  private check() {
    if (this.failed) throw this.fault;
  }
  private queue(work: () => Promise<void>) {
    const task = this.tail.then(() => {
      this.check();
      return work();
    });
    this.tail = task.catch((error) => {
      this.failed = true;
      this.fault = error;
    });
    return task;
  }
  async assertCurrent() {
    await this.queue(async () => {
      if (!equal(await this.persistence.read(), this.saved))
        throw Error("Notes changed in another view. Reopen before editing.");
    });
  }
  private commit(
    nextRaw: string,
    signal?: AbortSignal,
    authorized: () => void = () => {},
  ) {
    return this.queue(async () => {
      signal?.throwIfAborted();
      authorized();
      signal?.throwIfAborted();
      let next: Snapshot | null;
      try {
        next = await this.persistence.compareExchange(
          structuredClone(this.saved),
          nextRaw,
          signal,
        );
        if (next !== null) {
          next = structuredClone(next);
          if (this.persistence.raw(next) !== nextRaw)
            throw Error("Notes acknowledgement does not match the edit");
        }
      } catch {
        throw new NotesCommitUncertain(
          "Notes commit outcome is unknown; do not repeat the edit.",
        );
      }
      if (next === null)
        throw Error(
          "Notes changed in another view. Unsaved text remains on this screen.",
        );
      let current: Snapshot | null;
      try {
        current = await this.persistence.read();
      } catch {
        throw new NotesCommitUncertain(
          "Notes saved acknowledgement could not be verified. Do not repeat the edit.",
        );
      }
      if (!equal(current, next))
        throw new NotesCommitUncertain(
          "Notes readback changed. Inspect saved data before another edit.",
        );
      this.saved = next;
    });
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
      await this.assertCurrent();
      signal.throwIfAborted();
      authorized();
      const before = this.raw;
      const result = await this.inner.execute(op, id, signal, authorized);
      if (this.raw !== before) await this.commit(this.raw, signal, authorized);
      return result;
    } finally {
      this.activeOperation = false;
    }
  }
}
