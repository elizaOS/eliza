/**
 * Which saved reminders and events a note link may stop pointing from, decided only by durable
 * deletion receipts. Absence from a filtered calendar range or a pending list never retires a
 * link: only a committed (`deleted`) receipt the current owner may see, for the same source
 * revision, whose row is still the deleted one. Deleting one occurrence of a series keeps the
 * series' link. The host owns its deletion stores and supplies them through
 * {@link NoteDeletionReceiptsPort}; this module owns the rule.
 */
import {
  type NoteOriginIndex,
  type NoteOriginKind,
  removeNoteOrigin,
} from "./note-origin.ts";

export interface NoteDeletionReceipt<Row> {
  owner: string;
  phase: string;
  target: { sourceRevision: string; row: Row };
}
export interface ReminderDeletionSource {
  sourceRevision: string;
  reminders: ReadonlyArray<{
    id: string;
    status?: string;
    occurrenceId?: string | null;
  }>;
  deletions?: Record<
    string,
    NoteDeletionReceipt<{ id: string; occurrenceId?: string | null }>
  >;
}
export interface EventDeletionSource {
  sourceRevision: string;
  events: ReadonlyArray<{ id: string }>;
  deletions?: Record<
    string,
    NoteDeletionReceipt<{ id: string; seriesId?: string | null }>
  >;
}
export interface DeletedNoteOrigin {
  kind: NoteOriginKind;
  id: string;
}
/** The host's durable deletion receipts and the owner currently allowed to see them. */
export interface NoteDeletionReceiptsPort {
  reminders(): Promise<ReminderDeletionSource>;
  events(): Promise<EventDeletionSource>;
  visible(owner: string): boolean;
}

/** Only committed receipts with current source identity retire a link. */
export function verifiedDeletedNoteOrigins(
  reminders: ReminderDeletionSource,
  calendar: EventDeletionSource,
  visible: (owner: string) => boolean,
): DeletedNoteOrigin[] {
  const deleted: DeletedNoteOrigin[] = [];
  for (const receipt of Object.values(reminders.deletions || {})) {
    if (
      receipt.phase !== "deleted" ||
      !visible(receipt.owner) ||
      receipt.target.sourceRevision !== reminders.sourceRevision
    )
      continue;
    const row = reminders.reminders.find(
      (candidate) => candidate.id === receipt.target.row.id,
    );
    if (
      row?.status === "cancelled" &&
      row.occurrenceId === receipt.target.row.occurrenceId
    )
      deleted.push({ kind: "reminder", id: row.id });
  }
  for (const receipt of Object.values(calendar.deletions || {})) {
    const row = receipt.target.row;
    if (
      receipt.phase !== "deleted" ||
      !visible(receipt.owner) ||
      receipt.target.sourceRevision !== calendar.sourceRevision
    )
      continue;
    // Deleting one occurrence must retain its series' From note link.
    if (
      row.seriesId ||
      /:occ:-?\d+$/.test(row.id) ||
      calendar.events.some((current) => current.id === row.id)
    )
      continue;
    deleted.push({ kind: "event", id: row.id });
  }
  return deleted;
}

/** Reads the host's receipts and applies {@link verifiedDeletedNoteOrigins}. */
export async function deletedNoteOrigins(
  port: NoteDeletionReceiptsPort,
): Promise<DeletedNoteOrigin[]> {
  const reminders = await port.reminders();
  const events = await port.events();
  return verifiedDeletedNoteOrigins(reminders, events, (owner) =>
    port.visible(owner),
  );
}

/** Removes the links of the deleted records; an index with none of them is returned as is. */
export function withoutDeletedNoteOrigins(
  index: NoteOriginIndex,
  deleted: readonly DeletedNoteOrigin[],
): NoteOriginIndex {
  let next = index;
  for (const { kind, id } of deleted) next = removeNoteOrigin(next, kind, id);
  return next;
}
