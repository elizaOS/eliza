import type {
  NotesTrashDocument,
  NotesTrashEntry,
  NotesTrashPolicy,
  TrashNote,
  TrashTarget,
} from "./notes-trash-policy.ts";

/**
 * Host inputs for Notes Trash maintenance. The host owns storage, locking and any content
 * outside the note record (for example a recording); this module only decides and orders.
 */
export interface NotesTrashMaintenanceHost<
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
  /** Saved note ids from authoritative storage, never from an optimistic editor list. */
  liveNoteIds(): Promise<ReadonlySet<string>>;
  /** The lock that also serializes deletion, restore and purge in every view. */
  withLock<R>(work: () => Promise<R>): Promise<R>;
  /**
   * Erase host-owned content of an expired entry before its row disappears. Resolve true
   * when nothing remains (or nothing was owned), false to retain the row for a later pass.
   */
  purge(entry: NotesTrashEntry<N, T>): Promise<boolean>;
}
export interface NotesTrashMaintenanceResult {
  /** Rows removed: stale (note live again) and purged expired entries. */
  removed: string[];
  /** Expired rows retained because their content could not be erased yet. */
  retained: string[];
}

/**
 * One maintenance pass. It takes the lock only when there is work, so idle checks never
 * queue behind a deletion, and re-plans under the lock. Idempotent: a second pass with the
 * same clock finds nothing to do, and an interrupted purge is simply repeated.
 */
export async function maintainNotesTrash<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
>(
  host: NotesTrashMaintenanceHost<N, T>,
  now = Date.now(),
): Promise<NotesTrashMaintenanceResult> {
  const result: NotesTrashMaintenanceResult = { removed: [], retained: [] };
  const doc = await host.read();
  if (!doc.entries.length) return result;
  const first = host.policy.plan(doc, await host.liveNoteIds(), now);
  if (!first.stale.length && !first.expired.length) return result;
  await host.withLock(async () => {
    const current = host.policy.plan(
      await host.read(),
      await host.liveNoteIds(),
      now,
    );
    const drop = current.stale.map((entry) => entry.id);
    for (const entry of current.expired) {
      try {
        if (await host.purge(entry)) drop.push(entry.id);
        else result.retained.push(entry.id);
      } catch {
        result.retained.push(entry.id);
      }
    }
    if (drop.length) {
      await host.edit((value) => host.policy.remove(value, drop));
      result.removed = drop;
    }
  });
  return result;
}
