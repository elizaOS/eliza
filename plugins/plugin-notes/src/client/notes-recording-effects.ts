/**
 * Recording effects of a device-local voice-note deletion over a host recording store.
 *
 * Every effect is identified by the deletion operation id and confirmed by readback
 * of the recording store and of saved Notes; nothing is retried. A failed or
 * unconfirmable step leaves the recovery row for review instead of guessing. The
 * host owns the recording store, the deletion lock (callers hold it), the Notes
 * commit, the Trash document, presentation and which rows its own view started.
 */
import type { NotesTarget } from "./notes-contract.ts";
import {
  deletionLeaseDue,
  leasedDeletionRow,
  type NotesRecordingDeletion,
  type NotesRecordingDeletionJournal,
  type PermanentDeletionEvidence,
  type PermanentDeletionStep,
  planInterruptedPermanentDeletion,
} from "./notes-recording-deletion.ts";
import type { NoteRecord } from "./notes-store.ts";

export interface NotesRecordingIdentity {
  audioId: string;
  noteId: string;
  operationId: string;
}
export interface NotesRecordingMetadata {
  audioId: string;
  noteId: string;
  /** Set while the recording is in the store's audio trash. */
  deletedAt?: unknown;
}
export interface NotesRecordingReceipt extends NotesRecordingIdentity {
  status: string;
}
/** The host's recording store. Moves, restores and erases carry the deletion operation id. */
export interface NotesRecordingStore {
  describe(input: { audioId: string }): Promise<NotesRecordingMetadata>;
  remove(input: NotesRecordingIdentity): Promise<unknown>;
  restore(input: NotesRecordingIdentity): Promise<unknown>;
  purge(input: NotesRecordingIdentity): Promise<NotesRecordingReceipt>;
  deletionStatus(input: NotesRecordingIdentity): Promise<NotesRecordingReceipt>;
}
export interface NotesRecordingEffectsHost {
  recordings: NotesRecordingStore;
  journal: NotesRecordingDeletionJournal;
  /** Saved records from authoritative storage, never an optimistic editor list. */
  savedNotes(): Promise<readonly { id: string; audio?: unknown }[]>;
  now(): number;
}
/** A Trash entry as far as its recording is concerned. */
export interface NotesRecordingTrashEntry {
  id: string;
  note: NoteRecord;
  target?: NotesTarget;
  audio?: { audioId: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const audioIdOf = (note: { audio?: unknown }) =>
  isRecord(note.audio) ? note.audio.audioId : undefined;
const identity = (row: NotesRecordingDeletion): NotesRecordingIdentity => ({
  audioId: row.audioId,
  noteId: row.note.id,
  operationId: row.id,
});
const sameOperation = (
  receipt: NotesRecordingIdentity,
  row: NotesRecordingDeletion,
) =>
  receipt.audioId === row.audioId &&
  receipt.noteId === row.note.id &&
  receipt.operationId === row.id;

export function createNotesRecordingEffects(host: NotesRecordingEffectsHost) {
  const { recordings, journal } = host;

  /** This operation's own receipt on the recording must be exactly `status`. */
  async function confirmReceipt(
    row: NotesRecordingDeletion,
    status: "removed" | "restored",
  ): Promise<void> {
    const receipt = await recordings.deletionStatus(identity(row));
    if (!sameOperation(receipt, row) || receipt.status !== status)
      throw Error("Audio operation unconfirmed");
  }

  /** True while any saved note is the reviewed note or refers to its recording. */
  async function recordingStillSaved(row: NotesRecordingDeletion) {
    return (await host.savedNotes()).some(
      (note) => note.id === row.note.id || audioIdOf(note) === row.audioId,
    );
  }

  /**
   * Erase the recording of a deletion whose tombstone is committed and whose audio
   * trash this operation owns. Idempotent: a recording this operation already erased
   * is only confirmed. A recording any saved note references is never erased.
   */
  async function eraseForever(row: NotesRecordingDeletion): Promise<void> {
    const status = await recordings.deletionStatus(identity(row));
    if (!sameOperation(status, row)) throw Error("Audio operation unconfirmed");
    if (status.status === "purged") return;
    if (status.status !== "removed") throw Error("Audio operation unconfirmed");
    if (await recordingStillSaved(row))
      throw Error("A saved note references this recording");
    const result = await recordings.purge(identity(row));
    if (!sameOperation(result, row) || result.status !== "purged")
      throw Error("Recording erase unconfirmed");
  }

  /**
   * Erase the recording of an expiring or permanently deleted Trash entry. Resolves
   * false, keeping the entry, while a recovery row still covers this deletion or a
   * saved note (live again, re-associated, or in a reset collection) refers to it.
   */
  async function purgeTrashed(
    entry: NotesRecordingTrashEntry,
  ): Promise<boolean> {
    if (!entry.audio) return true;
    if ((await journal.pending())[entry.id]) return false;
    if (!entry.target) throw Error("This Trash entry has no recording");
    const row: NotesRecordingDeletion = {
      id: entry.id,
      target: entry.target,
      note: entry.note,
      audioId: entry.audio.audioId,
    };
    if (await recordingStillSaved(row)) return false;
    const result = await recordings.purge(identity(row));
    if (!sameOperation(result, row) || result.status !== "purged")
      throw Error("Recording erase unconfirmed");
    return true;
  }

  /**
   * An approved deletion of a voice note outside the editor (for example an agent
   * request). The caller holds the deletion lock. The Trash row and the recovery row
   * are written before the tombstone commit; afterwards the recording moves to the
   * audio trash under the same operation id, so Trash restores or purges note and
   * recording together. A failure after the commit leaves the recovery row for
   * review; it never repeats a possibly completed effect. A recording that is already
   * gone or owned elsewhere is left alone and only the note goes to Trash.
   */
  async function trashWithRecording<R>(input: {
    note: NoteRecord;
    target: NotesTarget;
    operationId: string;
    /** Records the restorable copy; `audio` is set only when the recording follows the note. */
    addTrashEntry(audio: { audioId: string } | undefined): Promise<void>;
    /** Commits this operation's tombstone for the reviewed revision. */
    commit(): Promise<R>;
  }): Promise<R> {
    const { note, target, operationId } = input;
    const audio = isRecord(note.audio) ? note.audio : undefined;
    const audioId = audio?.audioId;
    let row: NotesRecordingDeletion | undefined;
    if (
      typeof audioId === "string" &&
      audioId &&
      audio?.noteId === note.id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        operationId,
      )
    ) {
      if (
        Object.values(await journal.pending()).some(
          (pending) => pending.note.id === note.id,
        )
      )
        throw Error("A deletion of this voice note needs review first");
      const metadata = await recordings.describe({ audioId }).catch(() => null);
      if (
        metadata &&
        metadata.noteId === note.id &&
        metadata.audioId === audioId &&
        !metadata.deletedAt
      )
        row = { id: operationId, target, note, audioId };
    }
    await input.addTrashEntry(row ? { audioId: row.audioId } : undefined);
    if (!row) return input.commit();
    await journal.change(row, true);
    let result: R;
    try {
      result = await input.commit();
    } catch (error) {
      // Proven unchanged: retire the recovery row. Otherwise it stays for review.
      try {
        if ((await journal.noteState(row)) === "original")
          await journal.change(row, false);
      } catch {
        /* Retained for review. */
      }
      throw error;
    }
    try {
      if ((await journal.noteState(row)) !== "deleted")
        throw Error("Saved note changed");
      const retained = await recordings.describe({ audioId: row.audioId });
      if (retained.noteId !== row.note.id || retained.audioId !== row.audioId)
        throw Error("Recording association changed");
      const dispatched: NotesRecordingDeletion = {
        ...row,
        audioRequested: true,
      };
      await journal.change(row, false, dispatched);
      row = dispatched;
      if (!retained.deletedAt)
        try {
          await recordings.remove(identity(row));
        } catch {
          /* Readback only. */
        }
      const removed = await recordings.describe({ audioId: row.audioId });
      if (removed.noteId !== row.note.id || !removed.deletedAt)
        throw Error("Recording deletion unconfirmed");
      await confirmReceipt(row, "removed");
      await journal.change(row, false);
    } catch {
      /* The committed note deletion stands; the recovery row keeps the recording under review. */
    }
    return result;
  }

  /**
   * Backstop for a permanent deletion that process death interrupted. The caller
   * holds the deletion lock and passes only rows an earlier process wrote, so none
   * of its effects is in flight. Every input is read back; the plan either finishes
   * the confirmed deletion for exactly this note and recording or returns to the
   * state before it, and anything else stays under review. Resolves the step taken;
   * the row is retired unless the step is `review`.
   */
  async function settleInterrupted(
    row: NotesRecordingDeletion,
    commitDeletion: (row: NotesRecordingDeletion) => Promise<unknown>,
  ): Promise<PermanentDeletionStep> {
    const note = await journal.noteState(row);
    let recording: PermanentDeletionEvidence["recording"] = null;
    let receipt: PermanentDeletionEvidence["receipt"] = null;
    try {
      const metadata = await recordings.describe({ audioId: row.audioId });
      recording = {
        ownedByNote:
          metadata.audioId === row.audioId && metadata.noteId === row.note.id,
        inAudioTrash: !!metadata.deletedAt,
      };
      const status = await recordings.deletionStatus(identity(row));
      if (
        sameOperation(status, row) &&
        ["unknown", "removed", "restored", "purged"].includes(status.status)
      )
        receipt = status.status as PermanentDeletionEvidence["receipt"];
    } catch {
      /* Unreadable recording state: the plan keeps the row under review. */
    }
    const referencedElsewhere = (await host.savedNotes()).some(
      (saved) => saved.id !== row.note.id && audioIdOf(saved) === row.audioId,
    );
    const step = planInterruptedPermanentDeletion({
      note,
      recording,
      receipt,
      referencedElsewhere,
    });
    if (step === "review") return step;
    if (step === "erase") await eraseForever(row);
    else if (step === "trash-then-erase") {
      // Same order as the uninterrupted deletion: dispatch mark, audio trash, erase.
      if (!row.audioRequested) {
        const dispatched = leasedDeletionRow(
          { ...row, audioRequested: true as const },
          host.now(),
        );
        await journal.change(row, false, dispatched);
        row = dispatched;
      }
      await recordings.remove(identity(row));
      const removed = await recordings.describe({ audioId: row.audioId });
      if (
        removed.noteId !== row.note.id ||
        !removed.deletedAt ||
        (await journal.noteState(row)) !== "deleted"
      )
        throw Error("Deletion unconfirmed");
      // eraseForever accepts this operation's `removed` (it then erases) or `purged`:
      // a native pass that shares no lock may have finished the same operation.
      await eraseForever(row);
    } else if (step === "restore-recording") {
      await recordings.restore(identity(row));
      await confirmReceipt(row, "restored");
      const restored = await recordings.describe({ audioId: row.audioId });
      if (
        restored.deletedAt ||
        restored.noteId !== row.note.id ||
        (await journal.noteState(row)) !== "original"
      )
        throw Error("Rollback unconfirmed");
    } else if (step === "delete-note") {
      // The recording is already erased; the tombstone is for the reviewed revision only.
      await commitDeletion(row);
      if ((await journal.noteState(row)) !== "deleted")
        throw Error("Deletion unconfirmed");
    }
    await journal.change(row, false);
    return step;
  }

  /**
   * One status pass over a recovery row; the caller holds the deletion lock. A
   * permanent row this view did not start is settled only while no other live view
   * claims it. Any other row is retired once its recording is in this operation's
   * audio trash and its tombstone is committed (a permanent row finishes its erase
   * first). Resolves whether the row was retired; readback failures propagate and
   * leave it under review.
   */
  async function reconcile(
    row: NotesRecordingDeletion,
    options: {
      startedHere: boolean;
      claimedElsewhere(): Promise<boolean>;
      commitDeletion(row: NotesRecordingDeletion): Promise<unknown>;
    },
  ): Promise<boolean> {
    if (row.permanent && !options.startedHere) {
      if (await options.claimedElsewhere()) return false;
      return (
        (await settleInterrupted(row, options.commitDeletion)) !== "review"
      );
    }
    const metadata = await recordings.describe({ audioId: row.audioId });
    if (
      metadata.audioId === row.audioId &&
      metadata.noteId === row.note.id &&
      metadata.deletedAt &&
      (await journal.noteState(row)) === "deleted"
    ) {
      if (row.permanent) await eraseForever(row);
      else await confirmReceipt(row, "removed");
      await journal.change(row, false);
      return true;
    }
    return false;
  }

  /**
   * Keep every row still under review leased, so native passes never erase what a
   * restore offers. A failed renewal is retried on the next pass.
   */
  async function renewLeases(): Promise<void> {
    const now = host.now();
    for (const row of Object.values(await journal.pending()))
      if (deletionLeaseDue(row, now))
        try {
          await journal.change(row, false, leasedDeletionRow(row, now));
        } catch {
          /* Renewed on the next pass. */
        }
  }

  return {
    confirmReceipt,
    eraseForever,
    purgeTrashed,
    trashWithRecording,
    settleInterrupted,
    reconcile,
    renewLeases,
  };
}
export type NotesRecordingEffects = ReturnType<
  typeof createNotesRecordingEffects
>;
