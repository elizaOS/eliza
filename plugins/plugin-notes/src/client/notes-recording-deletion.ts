/**
 * Device-local deletion of a voice note's recording.
 *
 * Deleting a voice note has two separately durable effects: the note's tombstone in
 * the saved Notes collection and its recording in the host's audio store. A recovery
 * row (`NotesRecordingDeletion`) records the reviewed intent before either effect and
 * is retired only after both are confirmed, so an interruption at any point leaves a
 * reviewable row instead of a lost or repeated effect.
 *
 * This module owns the row contract, its journal protocol over a host compare-and-
 * exchange store, authoritative readback of the reviewed note, the startup backstop
 * plan for an interrupted permanent deletion, the renderer lease that keeps native
 * passes away from a row a live view is working on, cross-view claims and the
 * same-origin deletion lock. Hosts own storage slots, the recording store, the
 * lock name, presentation and the order of their own effects.
 */
import { type NotesTarget, notesTarget } from "./notes-contract.ts";
import { type NoteRecord, NotesStore } from "./notes-store.ts";

/**
 * One reviewed deletion of a voice note and its recording. `id` is the deletion
 * operation id shared with the note tombstone, the Trash row and the recording
 * store's receipt. `audioRequested` marks that the recording move was dispatched;
 * `permanent` marks a separately confirmed deletion that skipped a full Trash, so
 * recovery finishes the erase instead of leaving a Trash entry.
 */
export interface NotesRecordingDeletion {
  id: string;
  target: NotesTarget;
  note: NoteRecord;
  audioId: string;
  audioRequested?: true;
  permanent?: true;
  lease?: DeletionLease;
}
export type NotesRecordingDeletions = Record<string, NotesRecordingDeletion>;

/** Where the reviewed note stands in authoritative saved storage. */
export type NotesRecordingNoteState = "deleted" | "original" | "changed";

export interface NotesRecordingDeletionJournalPorts {
  /** The raw journal from authoritative storage; null when nothing was written. */
  read(): Promise<unknown>;
  /**
   * Replace the journal with `change(raw)` atomically against the value read.
   * Throw when the stored journal changed meanwhile; the journal reads back to
   * confirm every change.
   */
  edit(change: (raw: unknown) => NotesRecordingDeletions): Promise<void>;
  /** The saved Notes envelope (raw JSON) from authoritative storage. */
  readSavedNotes(): Promise<string>;
}
export interface NotesRecordingDeletionJournalOptions {
  /** The note kind that owns a recording. Defaults to "voice". */
  recordingKind?: string;
  /** Rows kept at once. Defaults to 100. */
  maxRows?: number;
  /** Encoded journal bytes. Defaults to 1 MiB. */
  maxBytes?: number;
}

const OPERATION_ID = /^[-\w]{1,128}$/;
const encoder = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A read-only store over one saved envelope: target revisions use the shared hash. */
function readOnlyNotes(raw: string): NotesStore {
  return new NotesStore(
    { current: "notes", legacy: "legacy-notes" },
    {
      getItem: (key) => (key === "notes" ? raw : null),
      setItem: () => {
        throw Error("Read-only Notes recovery");
      },
    },
  );
}

/**
 * The deletion journal over a host compare-and-exchange store. Every read is
 * validated; every change is checked against the row it expects and read back.
 * Nothing here dispatches a deletion or replays one.
 */
export function createNotesRecordingDeletionJournal(
  ports: NotesRecordingDeletionJournalPorts,
  options: NotesRecordingDeletionJournalOptions = {},
) {
  const recordingKind = options.recordingKind ?? "voice";
  const maxRows = options.maxRows ?? 100;
  const maxBytes = options.maxBytes ?? 1024 * 1024;

  function validate(value: unknown): NotesRecordingDeletions {
    if (value === null || value === undefined) return {};
    if (
      !isRecord(value) ||
      Object.keys(value).length > maxRows ||
      encoder.encode(JSON.stringify(value)).length > maxBytes
    )
      throw Error("Invalid recording deletion recovery store");
    for (const [id, raw] of Object.entries(value)) {
      if (!isRecord(raw)) throw Error("Invalid recording deletion binding");
      const row = raw as unknown as NotesRecordingDeletion;
      notesTarget(row.target);
      const audio = isRecord(row.note) ? row.note.audio : undefined;
      if (
        row.id !== id ||
        !OPERATION_ID.test(id) ||
        !isRecord(row.note) ||
        row.note.id !== row.target.noteId ||
        row.note.kind !== recordingKind ||
        !isRecord(audio) ||
        audio.audioId !== row.audioId ||
        audio.noteId !== row.note.id ||
        typeof row.audioId !== "string" ||
        !row.audioId ||
        (row.audioRequested !== undefined && row.audioRequested !== true) ||
        (row.permanent !== undefined && row.permanent !== true)
      )
        throw Error("Invalid recording deletion binding");
    }
    return value as NotesRecordingDeletions;
  }

  /** Rows still awaiting confirmation, each bound to its exact reviewed revision. */
  async function pending(): Promise<NotesRecordingDeletions> {
    const rows = validate(await ports.read());
    for (const row of Object.values(rows)) {
      const raw = JSON.stringify({
        version: 2,
        collectionId: row.target.sourceId,
        records: [row.note],
        deleted: [],
      });
      if (
        JSON.stringify(await readOnlyNotes(raw).target(row.note.id)) !==
        JSON.stringify(row.target)
      )
        throw Error("Reviewed deletion snapshot changed");
    }
    return rows;
  }

  /**
   * Add `row` (`create`), replace it with `updated`, or retire it. A create is
   * refused while any row for the same note exists; a replace or retire is
   * refused unless the stored row is exactly `row`.
   */
  async function change(
    row: NotesRecordingDeletion,
    create: boolean,
    updated?: NotesRecordingDeletion,
  ): Promise<void> {
    await ports.edit((raw) => {
      const all = validate(raw);
      const prior = all[row.id];
      if (
        create
          ? !!prior ||
            Object.values(all).some((other) => other.note.id === row.note.id)
          : JSON.stringify(prior) !== JSON.stringify(row)
      )
        throw Error("Recording deletion changed");
      const next = { ...all };
      if (create || updated) next[row.id] = updated ?? row;
      else delete next[row.id];
      return validate(next);
    });
    if (
      JSON.stringify((await pending())[row.id] ?? null) !==
      JSON.stringify(updated ?? (create ? row : null))
    )
      throw Error("Recording deletion persistence unconfirmed");
  }

  /**
   * Read authoritative storage, never an optimistic editor snapshot: `deleted`
   * only for this operation's own tombstone of the exact reviewed revision,
   * `original` only while the exact reviewed revision is still saved.
   */
  async function noteState(
    row: NotesRecordingDeletion,
  ): Promise<NotesRecordingNoteState> {
    const raw = await ports.readSavedNotes();
    if (typeof raw !== "string") throw Error("Notes readback unavailable");
    const store = readOnlyNotes(raw);
    const note = store.list.find((saved) => saved.id === row.note.id);
    if (
      !note &&
      store.list.some(
        (saved) => isRecord(saved.audio) && saved.audio.audioId === row.audioId,
      )
    )
      return "changed";
    if (!note) {
      const envelope = JSON.parse(raw) as {
        collectionId?: unknown;
        deleted?: Array<{
          id?: unknown;
          revision?: unknown;
          operationId?: unknown;
        }>;
      };
      return envelope.collectionId === row.target.sourceId &&
        Array.isArray(envelope.deleted) &&
        envelope.deleted.some(
          (tombstone) =>
            tombstone.id === row.note.id &&
            tombstone.revision === row.target.revision &&
            tombstone.operationId === row.id,
        )
        ? "deleted"
        : "changed";
    }
    return JSON.stringify(await store.target(row.note.id)) ===
      JSON.stringify(row.target)
      ? "original"
      : "changed";
  }

  return { validate, pending, change, noteState };
}
export type NotesRecordingDeletionJournal = ReturnType<
  typeof createNotesRecordingDeletionJournal
>;

/**
 * Evidence for the startup backstop of a permanent deletion (a full Trash refused
 * the restorable copy and the owner separately confirmed deletion) that process
 * death interrupted. Every field is authoritative readback taken under the
 * deletion lock after it was acquired.
 */
export interface PermanentDeletionEvidence {
  /**
   * `deleted` only for this operation's own tombstone of the reviewed revision,
   * `original` only while that exact revision is saved, `changed` otherwise
   * (edited, restored as another revision, deleted by another operation, reset).
   */
  note: NotesRecordingNoteState;
  /** Recording metadata readback, or null when it could not be read. */
  recording: { ownedByNote: boolean; inAudioTrash: boolean } | null;
  /** This operation's own receipt on that recording, or null when unreadable. */
  receipt: "unknown" | "removed" | "restored" | "purged" | null;
  /** A saved note other than the reviewed one references this recording. */
  referencedElsewhere: boolean;
}
/**
 * - `retire`: nothing is left to do; only the recovery row goes.
 * - `erase`: the tombstone is committed and this operation owns the audio trash; erase and retire.
 * - `trash-then-erase`: the tombstone is committed and the recording was never moved; move it
 *   to the audio trash under this operation, erase it, retire.
 * - `restore-recording`: the note was never deleted but this operation holds its recording in
 *   the audio trash; give it back and retire (rollback).
 * - `delete-note`: this operation already erased the recording but the exact reviewed note is
 *   still saved; commit its tombstone and retire.
 * - `review`: ownership is not exact. Nothing is changed and the row stays.
 */
export type PermanentDeletionStep =
  | "retire"
  | "erase"
  | "trash-then-erase"
  | "restore-recording"
  | "delete-note"
  | "review";

/**
 * The single next step that either finishes the confirmed permanent deletion or
 * returns to the state before it. Pure: the caller holds the deletion lock, read
 * every input after taking it and applies the plan only to rows an earlier
 * process wrote, so no effect of the interrupted operation can still be in flight.
 */
export function planInterruptedPermanentDeletion(
  evidence: PermanentDeletionEvidence,
): PermanentDeletionStep {
  const { note, recording, receipt } = evidence;
  if (
    note === "changed" ||
    !recording ||
    !recording.ownedByNote ||
    receipt === null
  )
    return "review";
  if (note === "deleted") {
    // The recording of a deleted note is erased only while no saved note points at it.
    if (evidence.referencedElsewhere) return "review";
    if (receipt === "purged") return "retire";
    if (receipt === "removed")
      return recording.inAudioTrash ? "erase" : "review";
    // Never moved. In the audio trash without this operation's receipt means another deletion owns it.
    if (receipt === "unknown")
      return recording.inAudioTrash ? "review" : "trash-then-erase";
    // `restored`: a restore of this deletion was started; that operation never deletes again.
    return "review";
  }
  // The exact reviewed note is still saved.
  if (receipt === "purged") return "delete-note";
  if (receipt === "removed")
    return recording.inAudioTrash ? "restore-recording" : "review";
  // `unknown` (never dispatched) or `restored` (a restore already gave it back).
  return recording.inAudioTrash ? "review" : "retire";
}

/**
 * Renderer lease on a recovery row. Native passes that cannot take the renderer's
 * lock leave a leased row exactly as it is and may finish it only after the lease
 * has expired. Hosts renew it on every step and every status pass, more often than
 * half its length, so it outlives the gap between passes and expires soon after
 * the renderer is gone. A host's native pass must use the same length.
 */
export const PERMANENT_DELETION_LEASE_MS = 20 * 60 * 1000;
export interface DeletionLease {
  until: number;
}
/** The row with a lease running from `now`. Nothing else in the row changes. */
export function leasedDeletionRow<T extends object>(
  row: T,
  now: number,
): T & { lease: DeletionLease } {
  return { ...row, lease: { until: now + PERMANENT_DELETION_LEASE_MS } };
}
/** The same deletion row, whatever its lease. */
export function sameDeletionRow(a: object, b: object): boolean {
  return (
    JSON.stringify({ ...a, lease: undefined }) ===
    JSON.stringify({ ...b, lease: undefined })
  );
}
/** True when the row's lease is due for renewal: absent, malformed, or less than half left. */
export function deletionLeaseDue(row: object, now: number): boolean {
  const until = (row as { lease?: Partial<DeletionLease> }).lease?.until;
  return (
    typeof until !== "number" ||
    !Number.isFinite(until) ||
    until - now < PERMANENT_DELETION_LEASE_MS / 2
  );
}

/** The subset of the Web Locks API the deletion helpers use. */
export interface NotesDeletionLocks {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
  query?(): Promise<{
    held?: Array<{ name?: string }>;
    pending?: Array<{ name?: string }>;
  }>;
}
const webLocks = (): NotesDeletionLocks | undefined =>
  (globalThis.navigator as { locks?: NotesDeletionLocks } | undefined)?.locks;

/**
 * One exclusive same-origin lock that serializes deletion, restoration, purge and
 * reviewed recovery across views. Without Web Locks the work is refused: safe
 * recovery cannot be proven without it.
 */
export function createNotesDeletionLock(
  name: string,
  locks: () => NotesDeletionLocks | undefined = webLocks,
) {
  return async function withNotesDeletionLock<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const manager = locks();
    if (!manager?.request)
      throw Error("Safe Notes deletion recovery requires Web Locks");
    return manager.request(
      name,
      { mode: "exclusive", ...(signal ? { signal } : {}) },
      work,
    );
  };
}

/**
 * Origin-wide claims on the deletions a live view started. A view holds a shared
 * lock per row it started until the row retires or the view goes away (the
 * browser releases it then), so another view never settles a row a live view
 * still holds. Per-process bookkeeping alone could not tell such a row from one
 * an earlier, closed view left.
 */
export function createNotesDeletionClaims(
  prefix: string,
  locks: () => NotesDeletionLocks | undefined = webLocks,
) {
  const claims = new Map<string, () => void>();
  return {
    claim(id: string): void {
      const manager = locks();
      if (claims.has(id) || !manager?.request) return;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      claims.set(id, release);
      void manager
        .request(prefix + id, { mode: "shared" }, () => held)
        .catch(() => {
          claims.delete(id);
        });
    },
    release(id: string): void {
      claims.get(id)?.();
      claims.delete(id);
    },
    /** True when another live view of this origin holds the claim on this row. */
    async claimedElsewhere(id: string): Promise<boolean> {
      const manager = locks();
      if (claims.has(id) || !manager?.query) return false;
      const state = await manager.query();
      return [...(state.held ?? []), ...(state.pending ?? [])].some(
        (lock) => lock.name === prefix + id,
      );
    },
  };
}
