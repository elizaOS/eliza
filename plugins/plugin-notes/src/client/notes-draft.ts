/**
 * Unsaved device-local Notes edits and their conflict merge.
 *
 * After a failed or uncertain collection commit, a host keeps the attempted edits
 * as a change set against the collection they were edited from: changed or added
 * records, removed IDs and the saved bytes of every record the draft touches.
 * Applying the draft later adds its new notes and applies an edit or removal only
 * while that note is unchanged since; every newer saved edit, including a newer
 * edit of the same note, wins and is reported as a conflict instead.
 *
 * The host owns the encrypted slot (`NotesVault`), presentation and recovery
 * export. Nothing here reads or writes plaintext storage or replays a commit.
 */
import type { NotesVault } from "./notes-secure-store.ts";
import type { NoteRecord } from "./notes-store.ts";

export type NotesDraftReason = "failed" | "uncertain" | "storage-full";
export interface NotesDraftChanges {
  records: NoteRecord[];
  added: string[];
  removed: string[];
  /** Saved JSON of each changed or removed record when the draft was taken. */
  before: Record<string, string>;
}
export interface NotesDraft extends NotesDraftChanges {
  version: 1;
  savedAt: number;
  /** SHA-256 of the collection bytes the edits were made against. */
  base: string;
  reason: NotesDraftReason;
}

/** Hex SHA-256 of a saved collection's exact bytes. */
export async function notesDraftBase(raw: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function validateNotesDraft(value: unknown): NotesDraft {
  const draft = value as NotesDraft;
  if (
    !draft ||
    typeof draft !== "object" ||
    draft.version !== 1 ||
    !Number.isFinite(draft.savedAt) ||
    typeof draft.base !== "string" ||
    !/^[a-f0-9]{64}$/.test(draft.base) ||
    !["failed", "uncertain", "storage-full"].includes(draft.reason) ||
    !Array.isArray(draft.records) ||
    draft.records.some(
      (record) =>
        !record || typeof record !== "object" || typeof record.id !== "string",
    ) ||
    [draft.added, draft.removed].some(
      (ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== "string"),
    ) ||
    !draft.before ||
    typeof draft.before !== "object" ||
    Array.isArray(draft.before) ||
    Object.values(draft.before).some((saved) => typeof saved !== "string")
  )
    throw Error("Invalid Notes draft");
  return draft;
}

/** The change set from `saved` to the attempted editor `list`. */
export function notesDraftChanges(
  list: NoteRecord[],
  saved: NoteRecord[],
): NotesDraftChanges {
  const before = new Map(saved.map((note) => [note.id, JSON.stringify(note)]));
  const after = new Set(list.map((note) => note.id));
  const records = list.filter(
    (note) => before.get(note.id) !== JSON.stringify(note),
  );
  const removed = saved
    .filter((note) => !after.has(note.id))
    .map((note) => note.id);
  const prior: Record<string, string> = {};
  for (const id of [...records.map((note) => note.id), ...removed]) {
    const value = before.get(id);
    if (value !== undefined) prior[id] = value;
  }
  return {
    records,
    added: records
      .filter((note) => !before.has(note.id))
      .map((note) => note.id),
    removed,
    before: prior,
  };
}

/** IDs whose saved note changed since the draft and differs from the drafted copy. */
export function notesDraftConflicts(
  list: NoteRecord[],
  draft: NotesDraftChanges,
): string[] {
  const drafted = new Map(
    draft.records.map((note) => [note.id, JSON.stringify(note)]),
  );
  const added = new Set(draft.added);
  const removed = new Set(draft.removed);
  return list
    .filter((note) => {
      const now = JSON.stringify(note);
      if (removed.has(note.id)) return now !== draft.before[note.id];
      if (!drafted.has(note.id) || added.has(note.id)) return false;
      return now !== draft.before[note.id] && now !== drafted.get(note.id);
    })
    .map((note) => note.id);
}

/**
 * Apply a draft over the current saved list. Draft-created notes come first; a
 * drafted edit or removal applies only while that note is unchanged since the
 * draft. A drafted edit of a note deleted since is not revived.
 */
export function applyNotesDraft(
  list: NoteRecord[],
  draft: NotesDraftChanges,
): NoteRecord[] {
  const drafted = new Map(draft.records.map((note) => [note.id, note]));
  const added = new Set(draft.added);
  const removed = new Set(draft.removed);
  const present = new Set(list.map((note) => note.id));
  const unchanged = (note: NoteRecord) =>
    JSON.stringify(note) === draft.before[note.id];
  return [
    ...draft.records.filter(
      (note) => added.has(note.id) && !present.has(note.id),
    ),
    ...list
      .filter((note) => !(removed.has(note.id) && unchanged(note)))
      .map((note) => {
        const replacement = drafted.get(note.id);
        return !added.has(note.id) && replacement && unchanged(note)
          ? replacement
          : note;
      }),
  ];
}

/**
 * Combine a newer change set with a draft that is still kept. The newer set wins
 * for every note it touches; the kept draft's other edits, creations and removals
 * stay with their own saved bytes, so a later failure never discards older
 * unsaved changes the editor did not show.
 */
export function mergeNotesDrafts(
  kept: NotesDraftChanges,
  next: NotesDraftChanges,
): NotesDraftChanges {
  const touched = new Set([
    ...next.records.map((note) => note.id),
    ...next.removed,
  ]);
  const records = [
    ...next.records,
    ...kept.records.filter((note) => !touched.has(note.id)),
  ];
  const ids = new Set(records.map((note) => note.id));
  const before: Record<string, string> = {};
  for (const [id, value] of Object.entries(kept.before))
    if (!touched.has(id)) before[id] = value;
  Object.assign(before, next.before);
  return {
    records,
    added: [
      ...next.added,
      ...kept.added.filter((id) => !touched.has(id) && ids.has(id)),
    ],
    removed: [
      ...next.removed,
      ...kept.removed.filter((id) => !touched.has(id)),
    ],
    before,
  };
}

export interface NotesDraftSaveInput {
  /** Bytes of the saved collection the edits were made against. */
  savedRaw: string;
  reason: NotesDraftReason;
  /** The attempted editor list. */
  list: NoteRecord[];
  /** The saved records the edits were made against. */
  saved: NoteRecord[];
  /** The draft this editor last saved; all of its edits are in `list`. */
  own?: NotesDraft | null;
  /** An earlier session's draft the editor never showed. */
  kept?: NotesDraft | null;
}

/**
 * One encrypted unsaved-draft slot. Compare-and-exchange keeps concurrent views
 * from overwriting each other's drafts; an unreadable slot is never replaced.
 */
export function createNotesDraftSlot(
  vault: NotesVault,
  slot: string,
  now: () => number = Date.now,
) {
  return {
    /** Throws for an unreadable or invalid slot, which needs recovery. */
    async read(): Promise<NotesDraft | null> {
      const value = await vault.read<unknown>(slot);
      return value === null ? null : validateNotesDraft(value);
    },
    /**
     * Persist a failed or uncertain commit's change set, merged with any other
     * kept draft. This editor's own previous draft is replaced so a reverted
     * edit is not resurrected. A capacity refusal propagates to the caller.
     */
    async save(input: NotesDraftSaveInput): Promise<NotesDraft> {
      const changes = notesDraftChanges(input.list, input.saved);
      const base = await notesDraftBase(input.savedRaw);
      for (let attempt = 0; attempt < 3; attempt++) {
        const expected = await vault.read<unknown>(slot);
        const prior =
          expected === null
            ? null
            : input.own &&
                JSON.stringify(expected) === JSON.stringify(input.own)
              ? (input.kept ?? null)
              : validateNotesDraft(expected);
        const merged = prior ? mergeNotesDrafts(prior, changes) : changes;
        const draft: NotesDraft = {
          version: 1,
          savedAt: now(),
          base,
          reason: input.reason,
          ...merged,
        };
        if (
          (await vault.compareExchange(slot, expected, draft)).status ===
          "saved"
        )
          return draft;
      }
      throw Error("Notes draft changed in another view");
    },
    /** Remove exactly the draft that was reviewed or applied. */
    async clear(expected: NotesDraft): Promise<boolean> {
      return (
        (await vault.compareExchange(slot, expected, null)).status === "saved"
      );
    },
  };
}
export type NotesDraftSlot = ReturnType<typeof createNotesDraftSlot>;

export type NotesEditorReconciliation =
  | { kind: "unchanged" }
  | { kind: "conflict" }
  | { kind: "refresh"; list?: NoteRecord[] };

/**
 * Reconcile a visible editor list with a newly settled collection (never a write
 * payload). The previously acknowledged raw collection is the editor's clean
 * baseline: only a clean editor adopts the committed records; an editor holding
 * unsaved changes reports a conflict and keeps them.
 */
export function reconcileNotesEditor(
  baselineRaw: string | undefined,
  visible: NoteRecord[],
  committedRaw: string,
  committed: NoteRecord[],
): NotesEditorReconciliation {
  if (baselineRaw === committedRaw) return { kind: "unchanged" };
  if (JSON.stringify(visible) === JSON.stringify(committed))
    return { kind: "refresh" };
  let baseline: unknown;
  try {
    baseline = JSON.parse(baselineRaw ?? "");
  } catch {
    return { kind: "conflict" };
  }
  if (
    !baseline ||
    typeof baseline !== "object" ||
    !("version" in baseline) ||
    baseline.version !== 2 ||
    !("records" in baseline) ||
    !Array.isArray(baseline.records) ||
    JSON.stringify(visible) !== JSON.stringify(baseline.records)
  )
    return { kind: "conflict" };
  return { kind: "refresh", list: structuredClone(committed) };
}
