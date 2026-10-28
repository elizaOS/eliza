/**
 * Owner-initiated device-local Notes Trash actions: move a note to Trash, restore,
 * delete forever and empty Trash, plus the separately confirmed permanent deletion
 * offered when a full Trash refused a restorable copy.
 *
 * Every action re-reads authoritative storage under the host's deletion lock, so a
 * stale view never replaces a newer edit or the only restorable copy of a newer
 * deletion. Write-ahead: the restorable copy is durable before the note leaves the
 * saved list. The host owns storage, the lock, list commits, owned content such as
 * recordings and presentation; actions resolve typed outcomes and never retry.
 */
import {
  isNotesTrashFull,
  type NotesTrashDocument,
  type NotesTrashEntry,
  type NotesTrashPolicy,
  type TrashNote,
  type TrashTarget,
} from "./notes-trash-policy.ts";

export interface NotesTrashActionsHost<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> {
  policy: NotesTrashPolicy<N, T>;
  /** Authoritative Trash document. */
  read(): Promise<NotesTrashDocument<N, T>>;
  /** Compare-and-exchange edit with readback. Called only while holding `withLock`. */
  edit(
    update: (current: NotesTrashDocument<N, T>) => NotesTrashDocument<N, T>,
  ): Promise<unknown>;
  /** Saved records from authoritative storage, never from an optimistic editor list. */
  savedNotes(): Promise<readonly N[]>;
  /** The lock that also serializes maintenance, recording deletion and purge in every view. */
  withLock<R>(work: () => Promise<R>): Promise<R>;
  /**
   * Erase content the host keeps outside the note record (a recording) before its
   * row disappears. Resolve true when nothing remains or nothing was owned.
   */
  purge(entry: NotesTrashEntry<N, T>): Promise<boolean>;
  /** Content outside the record that only the host's reviewed path may erase. */
  ownsContent?(note: N): boolean;
  now?(): number;
  operationId?(): string;
}

/** The collection this view edits. */
export interface NotesTrashCollection<N extends TrashNote = TrashNote> {
  /** False while a save is pending or storage needs recovery. */
  ready(): boolean;
  /** This view's last saved copy of the collection. */
  stored(): N[];
  /** The list this view shows, which may hold edits of other notes. */
  visible(): N[];
  /**
   * Save a list through the host's normal path and resolve true only when it is
   * confirmed. `remove` drops one note from the visible list; `restore` reinserts
   * a Trash copy into the saved list and must be saved exactly as given.
   */
  commit(list: N[], reason: "remove" | "restore"): Promise<boolean>;
}

export type NotesTrashMoveOutcome<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> =
  | { status: "moved"; entry: NotesTrashEntry<N, T> }
  /**
   * The restorable copy is saved but the list commit was not confirmed. The host's
   * save path reports that failure; maintenance drops the row if the note stays saved.
   */
  | { status: "unconfirmed"; entry: NotesTrashEntry<N, T> }
  /** Trash has no room for a restorable copy. Nothing was written. */
  | { status: "full" }
  /** This view's copy or Trash changed in another view. Nothing was deleted. */
  | { status: "changed" }
  | { status: "unavailable" }
  | { status: "failed" };
export type NotesTrashRestoreOutcome =
  | "restored"
  /** The note is already saved; only its stale Trash row was removed. */
  | "live"
  | "gone"
  | "expired"
  /** The entry owns a recording; the host restores it through its reviewed path. */
  | "owned-content"
  | "unconfirmed";
export interface NotesTrashEraseOutcome {
  status: "settled" | "unconfirmed";
  erased: number;
  /** Entries whose owned content could not be erased; they stay in Trash. */
  failed: number;
}
export type NotesTrashDeleteForeverOutcome =
  | "deleted"
  | "changed"
  /** The note owns a recording; the host deletes it through its reviewed path. */
  | "owned-content"
  | "unavailable"
  | "unconfirmed";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function createNotesTrashActions<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
>(host: NotesTrashActionsHost<N, T>) {
  const now = () => host.now?.() ?? Date.now();
  const operationId = () => host.operationId?.() ?? crypto.randomUUID();
  const rowsOf = (doc: NotesTrashDocument<N, T>, noteId: string) =>
    doc.entries
      .filter((row) => row.note.id === noteId)
      .map((row) => JSON.stringify(row))
      .sort()
      .join("\n");

  /**
   * Move one saved note to Trash. `target` binds the reviewed revision of the exact
   * record. The note must still equal both this view's copy and authoritative storage.
   */
  async function moveToTrash(
    collection: NotesTrashCollection<N>,
    note: N,
    index: number,
    target?: () => Promise<T>,
  ): Promise<NotesTrashMoveOutcome<N, T>> {
    if (!collection.ready()) return { status: "unavailable" };
    let changed = false;
    try {
      return await host.withLock(async () => {
        if (!collection.ready()) return { status: "unavailable" as const };
        const stored = collection.stored().find((item) => item.id === note.id);
        if (!same(stored, note)) throw Error("Note changed");
        const saved = (await host.savedNotes()).find(
          (item) => item.id === note.id,
        );
        if (!saved || !same(saved, note)) {
          changed = true;
          throw Error("Note changed");
        }
        const expected = rowsOf(await host.read(), note.id);
        const entry: NotesTrashEntry<N, T> = {
          id: operationId(),
          note: structuredClone(stored as N),
          ...(target ? { target: await target() } : {}),
          index: Math.max(0, Math.trunc(index)),
          deletedAt: now(),
        };
        // Only rows this pass read (stale write-ahead rows of a still-saved note) may be replaced.
        await host.edit((doc) => {
          if (rowsOf(doc, note.id) !== expected) {
            changed = true;
            throw Error("Trash changed");
          }
          return host.policy.add(doc, entry);
        });
        const committed = await collection.commit(
          collection.visible().filter((item) => item.id !== note.id),
          "remove",
        );
        return committed
          ? { status: "moved" as const, entry }
          : { status: "unconfirmed" as const, entry };
      });
    } catch (error) {
      if (isNotesTrashFull(error)) return { status: "full" };
      return { status: changed ? "changed" : "failed" };
    }
  }

  /** Restore one entry next to its old position. Never replaces a saved note. */
  async function restore(
    collection: NotesTrashCollection<N>,
    id: string,
  ): Promise<NotesTrashRestoreOutcome> {
    try {
      const entry = (await host.read()).entries.find((row) => row.id === id);
      if (!entry) return "gone";
      if (host.policy.expired(entry, now())) return "expired";
      if (entry.audio) return "owned-content";
      return await host.withLock(async () => {
        if (!collection.ready()) throw Error("Notes storage needs recovery");
        const current = (await host.read()).entries.find(
          (row) => row.id === id,
        );
        if (!current) return "gone";
        if (host.policy.expired(current, now()))
          throw Error("Trash retention expired");
        if ((await host.savedNotes()).some((n) => n.id === current.note.id)) {
          await host.edit((doc) => host.policy.remove(doc, [id]));
          return "live";
        }
        const list = host.policy.restore(collection.stored(), current);
        if (!(await collection.commit(list, "restore")))
          throw Error("Restore unconfirmed");
        await host.edit((doc) => host.policy.remove(doc, [id]));
        return "restored";
      });
    } catch {
      return "unconfirmed";
    }
  }

  /** Delete one entry forever, or every entry. Owned content is erased first. */
  async function erase(ids: "all" | string): Promise<NotesTrashEraseOutcome> {
    let failed = 0;
    let erased = 0;
    try {
      await host.withLock(async () => {
        const entries = (await host.read()).entries.filter(
          (entry) => ids === "all" || entry.id === ids,
        );
        const drop: string[] = [];
        for (const entry of entries) {
          try {
            if (await host.purge(entry)) drop.push(entry.id);
            else failed++;
          } catch {
            failed++;
          }
        }
        if (drop.length)
          await host.edit((doc) => host.policy.remove(doc, drop));
        erased = drop.length;
      });
      return { status: "settled", erased, failed };
    } catch {
      return { status: "unconfirmed", erased: 0, failed };
    }
  }

  /**
   * Permanent deletion without a Trash copy, offered only after a full Trash refused
   * this exact note and the owner confirmed separately. `snapshot` is the refused
   * record's JSON; a note that changed since, or that owns content, is left untouched.
   */
  async function deleteForever(
    collection: NotesTrashCollection<N>,
    id: string,
    snapshot: string,
  ): Promise<NotesTrashDeleteForeverOutcome> {
    try {
      return await host.withLock(async () => {
        if (!collection.ready()) return "unavailable";
        const stored = collection.stored().find((note) => note.id === id);
        if (!stored || JSON.stringify(stored) !== snapshot) return "changed";
        if (host.ownsContent?.(stored)) return "owned-content";
        const saved = (await host.savedNotes()).find((note) => note.id === id);
        if (!saved || JSON.stringify(saved) !== snapshot) return "changed";
        // A stale row would offer the permanently deleted note for restore again.
        const stale = (await host.read()).entries
          .filter((entry) => entry.note.id === id)
          .map((entry) => entry.id);
        if (stale.length)
          await host.edit((doc) => host.policy.remove(doc, stale));
        if (
          !(await collection.commit(
            collection.visible().filter((note) => note.id !== id),
            "remove",
          ))
        )
          return "unconfirmed";
        return (await host.savedNotes()).some((note) => note.id === id)
          ? "unconfirmed"
          : "deleted";
      });
    } catch {
      return "unconfirmed";
    }
  }

  return { moveToTrash, restore, erase, deleteForever };
}
export type NotesTrashActions<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> = ReturnType<typeof createNotesTrashActions<N, T>>;
