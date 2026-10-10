/**
 * Notes Trash policy: deleted notes stay restorable for a host-chosen retention and are
 * then purged. Pure and storage-agnostic. Hosts supply the retention, size limits, the note
 * kinds they store and which kind may own a recording; the host keeps the document in its
 * own durable store and decides presentation.
 *
 * Expiry uses epoch milliseconds, so time-zone and DST changes have no effect. A clock moved
 * backwards delays the purge rather than advancing it: early erasure is the unrecoverable
 * failure, so `deletedAt` is never rewritten from a possibly wrong clock.
 */
export interface TrashNote {
  id: string;
  kind: string;
  title: string;
  [key: string]: unknown;
}
/** The reviewed revision of the exact record at deletion, so a restore can prove identity. */
export interface TrashTarget {
  noteId: string;
  revision: string;
  sourceId: string;
}
/**
 * One trashed note. `id` is the deletion operation id. `audio` is present only when the
 * recording itself was moved to the host's audio trash under the same operation id.
 */
export interface NotesTrashEntry<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> {
  id: string;
  note: N;
  target?: T;
  index: number;
  deletedAt: number;
  audio?: { audioId: string };
}
export interface NotesTrashDocument<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> {
  version: 1;
  entries: NotesTrashEntry<N, T>[];
}
export interface NotesTrashPlan<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> {
  /** The note is live again (undo, restore, or a deletion that never committed). Only the row goes. */
  stale: NotesTrashEntry<N, T>[];
  /** Retention elapsed and the note is still absent. Content is purged. */
  expired: NotesTrashEntry<N, T>[];
  kept: NotesTrashEntry<N, T>[];
}
export interface NotesTrashPolicyOptions {
  retentionMs: number;
  maxEntries: number;
  maxBytes: number;
  /** Note kinds the host stores. Any other kind is refused rather than guessed. */
  kinds: readonly string[];
  /** The kind whose entries may carry a recording; omit when the host has none. */
  recordingKind?: string;
}

const DAY = 24 * 60 * 60 * 1000;
const operationId = /^[-\w]{1,128}$/;

export interface NotesTrashPolicy<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> {
  readonly retentionMs: number;
  empty(): NotesTrashDocument<N, T>;
  validate(value: unknown): NotesTrashDocument<N, T>;
  expiresAt(entry: Pick<NotesTrashEntry, "deletedAt">): number;
  expired(entry: Pick<NotesTrashEntry, "deletedAt">, now: number): boolean;
  /** Whole days left, rounded up; 0 once due. */
  daysLeft(entry: Pick<NotesTrashEntry, "deletedAt">, now: number): number;
  /** Record a deletion before it is committed. A newer deletion of the same note replaces a stale row. */
  add(
    doc: NotesTrashDocument<N, T>,
    entry: NotesTrashEntry<N, T>,
  ): NotesTrashDocument<N, T>;
  remove(
    doc: NotesTrashDocument<N, T>,
    ids: Iterable<string>,
  ): NotesTrashDocument<N, T>;
  /** Pure and idempotent: applying the plan and planning again yields nothing to do. */
  plan(
    doc: NotesTrashDocument<N, T>,
    liveNoteIds: ReadonlySet<string>,
    now: number,
  ): NotesTrashPlan<N, T>;
  /** Reinsert the exact record near its old position. Refuses to replace a live note with the same id. */
  restore(list: N[], entry: NotesTrashEntry<N, T>): N[];
  /** Newest deletion first. */
  sorted(doc: NotesTrashDocument<N, T>): NotesTrashEntry<N, T>[];
}

export function createNotesTrashPolicy<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
>(options: NotesTrashPolicyOptions): NotesTrashPolicy<N, T> {
  const { retentionMs, maxEntries, maxBytes, kinds, recordingKind } = options;
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0)
    throw Error("Notes Trash retention must be a positive integer");
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
    throw Error("Notes Trash entry limit must be a positive integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw Error("Notes Trash size limit must be a positive integer");
  const allowed = new Set(kinds);
  const maxDays = Math.ceil(retentionMs / DAY);
  const empty = (): NotesTrashDocument<N, T> => ({ version: 1, entries: [] });

  function validate(value: unknown): NotesTrashDocument<N, T> {
    if (value === null || value === undefined) return empty();
    const doc = value as NotesTrashDocument<N, T>;
    if (
      !doc ||
      typeof doc !== "object" ||
      Array.isArray(doc) ||
      doc.version !== 1 ||
      !Array.isArray(doc.entries) ||
      Object.keys(doc).some((key) => key !== "version" && key !== "entries")
    )
      throw Error("Invalid Notes Trash");
    const ids = new Set<string>(),
      notes = new Set<string>();
    for (const entry of doc.entries) {
      const note = entry?.note;
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.id !== "string" ||
        !operationId.test(entry.id) ||
        ids.has(entry.id) ||
        !note ||
        typeof note !== "object" ||
        typeof note.id !== "string" ||
        !note.id ||
        typeof note.title !== "string" ||
        !allowed.has(note.kind) ||
        notes.has(note.id) ||
        !Number.isSafeInteger(entry.index) ||
        entry.index < 0 ||
        !Number.isSafeInteger(entry.deletedAt) ||
        entry.deletedAt <= 0
      )
        throw Error("Invalid Notes Trash entry");
      if (
        entry.target !== undefined &&
        (entry.target === null ||
          typeof entry.target !== "object" ||
          entry.target.noteId !== note.id ||
          typeof entry.target.revision !== "string" ||
          typeof entry.target.sourceId !== "string")
      )
        throw Error("Invalid Notes Trash target");
      if (
        entry.audio !== undefined &&
        (entry.audio === null ||
          recordingKind === undefined ||
          note.kind !== recordingKind ||
          typeof entry.audio.audioId !== "string" ||
          !entry.audio.audioId ||
          (note.audio as { audioId?: string } | undefined)?.audioId !==
            entry.audio.audioId)
      )
        throw Error("Invalid Notes Trash recording");
      ids.add(entry.id);
      notes.add(note.id);
    }
    return doc;
  }
  const expiresAt = (entry: Pick<NotesTrashEntry, "deletedAt">) =>
    entry.deletedAt + retentionMs;
  const expired = (entry: Pick<NotesTrashEntry, "deletedAt">, now: number) =>
    now >= expiresAt(entry);
  return {
    retentionMs,
    empty,
    validate,
    expiresAt,
    expired,
    daysLeft(entry, now) {
      const left = expiresAt(entry) - now;
      return left <= 0 ? 0 : Math.min(maxDays, Math.ceil(left / DAY));
    },
    add(doc, entry) {
      const current = validate(doc);
      if (current.entries.some((x) => x.id === entry.id))
        throw Error("Deletion already recorded");
      const next = validate({
        version: 1,
        entries: [
          entry,
          ...current.entries.filter((x) => x.note.id !== entry.note.id),
        ],
      });
      // Limits admit new content; older documents must remain readable and shrinkable.
      if (
        next.entries.length > maxEntries ||
        new TextEncoder().encode(JSON.stringify(next)).length > maxBytes
      )
        throw Error("Notes Trash is full");
      return next;
    },
    remove(doc, ids) {
      const drop = new Set(ids);
      return validate({
        version: 1,
        entries: validate(doc).entries.filter((x) => !drop.has(x.id)),
      });
    },
    plan(doc, liveNoteIds, now) {
      const plan: NotesTrashPlan<N, T> = { stale: [], expired: [], kept: [] };
      for (const entry of validate(doc).entries) {
        if (liveNoteIds.has(entry.note.id)) plan.stale.push(entry);
        else if (expired(entry, now)) plan.expired.push(entry);
        else plan.kept.push(entry);
      }
      return plan;
    },
    restore(list, entry) {
      if (list.some((n) => n.id === entry.note.id))
        throw Error("A note with this identity already exists");
      const next = list.slice();
      next.splice(
        Math.min(entry.index, next.length),
        0,
        structuredClone(entry.note),
      );
      return next;
    },
    sorted(doc) {
      return validate(doc)
        .entries.slice()
        .sort((a, b) => b.deletedAt - a.deletedAt);
    },
  };
}
