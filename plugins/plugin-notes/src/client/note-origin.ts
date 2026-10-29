/**
 * Back-references from a saved reminder or calendar event to the voice note its
 * draft came from.
 *
 * A link is identity only: it grants no access to the note and carries none of its
 * content, not even its title. The title shown beside a link is read from the note
 * as it is now, so a renamed note is never shown under an old name and a deleted
 * note's title is not kept. Hosts persist the bounded index in their own storage;
 * this module owns validation, the series key and fail-closed resolution.
 */

export interface NoteOrigin {
  version: 1;
  noteId: string;
  audioId: string;
  /** Hash of the whole note record as reviewed when the link was made. */
  revision: string;
}
/**
 * A link to a canonical note record (any kind, not only a recording). `revision` hashes the
 * note's authored fields as reviewed when the link was made ({@link recordNoteRevision}).
 */
export interface RecordNoteOrigin {
  version: 2;
  noteId: string;
  revision: string;
}
/** Either link: a recording in a voice note (version 1) or a canonical note record (version 2). */
export type NoteLink = NoteOrigin | RecordNoteOrigin;
export type NoteOriginKind = "event" | "reminder";
export interface NoteOriginIndex {
  version: 1;
  links: Record<string, NoteLink & { savedAt: number }>;
}
export type NoteOriginResolution =
  | { status: "missing" }
  | { status: "found"; origin: NoteOrigin; note: Record<string, unknown> };
export type NoteLinkResolution =
  | { status: "missing" }
  | { status: "found"; origin: NoteLink; note: Record<string, unknown> };

export const NOTE_ORIGIN_LIMIT = 200;
const NOTE_ORIGIN_RECOVERY = "Note links need recovery.";

/** True when the text holds an ASCII control character (U+0000-U+001F or U+007F). */
const isControl = (code: number) => code <= 0x1f || code === 0x7f;
const hasControl = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    if (isControl(value.charCodeAt(i))) return true;
  }
  return false;
};
const withoutControls = (value: string) => {
  let out = "";
  let gap = false;
  for (const char of value) {
    if (isControl(char.charCodeAt(0))) {
      if (!gap) out += " ";
      gap = true;
    } else {
      out += char;
      gap = false;
    }
  }
  return out;
};
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !hasControl(value);

/** The exact link fields of a value, or undefined. A title or other field is dropped. */
export function noteOriginOf(value: unknown): NoteOrigin | undefined {
  const origin = value as Partial<NoteOrigin> | null | undefined;
  if (
    !origin ||
    typeof origin !== "object" ||
    origin.version !== 1 ||
    !text(origin.noteId, 128) ||
    !text(origin.audioId, 128) ||
    typeof origin.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(origin.revision)
  ) {
    return undefined;
  }
  return {
    version: 1,
    noteId: origin.noteId,
    audioId: origin.audioId,
    revision: origin.revision,
  };
}

/** The exact fields of a canonical record link, or undefined. */
export function recordNoteOriginOf(
  value: unknown,
): RecordNoteOrigin | undefined {
  const origin = value as Partial<RecordNoteOrigin> | null | undefined;
  if (
    !origin ||
    typeof origin !== "object" ||
    origin.version !== 2 ||
    !text(origin.noteId, 128) ||
    typeof origin.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(origin.revision)
  ) {
    return undefined;
  }
  return { version: 2, noteId: origin.noteId, revision: origin.revision };
}

/** The exact fields of either link kind, or undefined. */
export function noteLinkOf(value: unknown): NoteLink | undefined {
  return noteOriginOf(value) ?? recordNoteOriginOf(value);
}

/**
 * SHA-256 (lowercase hex) of a canonical note's authored fields: id, title, body and format.
 * Timestamps and colour are left out, so only an authored change reads as "edited since".
 */
export async function recordNoteRevision(note: {
  id: string;
  title?: unknown;
  body?: unknown;
  format?: unknown;
}): Promise<string> {
  const canonical = JSON.stringify([
    note.id,
    String(note.title ?? ""),
    String(note.body ?? ""),
    note.format ?? null,
  ]);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The link for a canonical note record as it is now. */
export async function recordNoteOriginFor(note: {
  id: string;
  title?: unknown;
  body?: unknown;
  format?: unknown;
}): Promise<RecordNoteOrigin | undefined> {
  return recordNoteOriginOf({
    version: 2,
    noteId: note?.id,
    revision: await recordNoteRevision(note),
  });
}

/** The origin for a saved recording as reviewed now. `revision` hashes the whole note record. */
export function noteOriginFor(
  note: unknown,
  revision: string,
): NoteOrigin | undefined {
  const row = note as
    | { id?: unknown; audio?: { audioId?: unknown } }
    | null
    | undefined;
  return noteOriginOf({
    version: 1,
    noteId: row?.id,
    audioId: row?.audio?.audioId,
    revision,
  });
}

/** The current title of a resolved note, for display only. It is never stored with a link. */
export function noteOriginTitle(
  note: unknown,
  fallback = "Voice note",
): string {
  const title = (note as { title?: unknown } | null | undefined)?.title;
  return (
    withoutControls(String(title || ""))
      .trim()
      .slice(0, 120) || fallback
  );
}

/** Events repeat as `<id>:occ:<begin>`; one link covers the series. */
export function noteOriginKey(kind: NoteOriginKind, id: string): string {
  return `${kind}:${kind === "event" ? id.replace(/:occ:-?\d+$/, "") : id}`;
}

/** Validates a stored index exactly; a malformed index is refused, never partly trusted. */
const validLinkKey = (key: string) => {
  const match = /^(event|reminder):(.{1,256})$/s.exec(key);
  return !!match && !hasControl(match[2]);
};

export function noteOriginIndex(value: unknown): NoteOriginIndex {
  if (value === null || value === undefined) return { version: 1, links: {} };
  const index = value as NoteOriginIndex;
  if (
    typeof index !== "object" ||
    Array.isArray(index) ||
    index.version !== 1 ||
    !index.links ||
    typeof index.links !== "object" ||
    Array.isArray(index.links) ||
    Object.keys(index).some((key) => key !== "version" && key !== "links")
  ) {
    throw new Error(NOTE_ORIGIN_RECOVERY);
  }
  const entries = Object.entries(index.links);
  if (entries.length > NOTE_ORIGIN_LIMIT) throw new Error(NOTE_ORIGIN_RECOVERY);
  const links: NoteOriginIndex["links"] = {};
  for (const [key, row] of entries) {
    const origin = noteLinkOf(row);
    if (
      !validLinkKey(key) ||
      !origin ||
      !Number.isSafeInteger(row.savedAt) ||
      row.savedAt < 0
    ) {
      throw new Error(NOTE_ORIGIN_RECOVERY);
    }
    links[key] = { ...origin, savedAt: row.savedAt };
  }
  return { version: 1, links };
}

/**
 * Adds a link for a newly saved record. An existing link for that record is never
 * replaced: a record keeps the note it was created from. The oldest links make room
 * past the limit.
 */
export function addNoteOrigin(
  index: NoteOriginIndex,
  kind: NoteOriginKind,
  id: string,
  value: unknown,
  now: number,
): NoteOriginIndex {
  const origin = noteLinkOf(value);
  const key = noteOriginKey(kind, id);
  // The same key check the index reader applies, so one bad id never makes the
  // persisted index need recovery.
  if (!origin || !id || !validLinkKey(key)) {
    throw new Error("Invalid note link.");
  }
  if (index.links[key]) return index;
  const links = { ...index.links, [key]: { ...origin, savedAt: now } };
  const oldest = Object.keys(links)
    .filter((candidate) => candidate !== key)
    .sort((a, b) => links[a].savedAt - links[b].savedAt);
  while (Object.keys(links).length > NOTE_ORIGIN_LIMIT && oldest.length) {
    delete links[oldest.shift() as string];
  }
  return { version: 1, links };
}

export function removeNoteOrigin(
  index: NoteOriginIndex,
  kind: NoteOriginKind,
  id: string,
): NoteOriginIndex {
  const key = noteOriginKey(kind, id);
  if (!index.links[key]) return index;
  const links = { ...index.links };
  delete links[key];
  return { version: 1, links };
}

export function findNoteOrigin(
  index: NoteOriginIndex,
  kind: NoteOriginKind,
  id: string,
): NoteOrigin | undefined {
  return noteOriginOf(index.links[noteOriginKey(kind, id)]);
}

/** The stored link of either kind for a record. */
export function findNoteLink(
  index: NoteOriginIndex,
  kind: NoteOriginKind,
  id: string,
): NoteLink | undefined {
  return noteLinkOf(index.links[noteOriginKey(kind, id)]);
}

/**
 * Resolves a link of either kind. A recording link resolves as {@link resolveNoteOrigin}; a
 * record link needs exactly one note under the stored id. Compare `revision` with
 * {@link recordNoteRevision} of the found note to say whether it was edited since.
 */
export function resolveNoteLink(
  value: unknown,
  notes: unknown,
): NoteLinkResolution {
  const record = recordNoteOriginOf(value);
  if (!record) return resolveNoteOrigin(value, notes);
  if (!Array.isArray(notes)) return { status: "missing" };
  const matches = notes.filter(
    (note: { id?: unknown } | null) => note && note.id === record.noteId,
  );
  return matches.length === 1
    ? {
        status: "found",
        origin: record,
        note: matches[0] as Record<string, unknown>,
      }
    : { status: "missing" };
}

/**
 * Resolves a link against the current Notes list. Fails closed: exactly one note
 * must still exist under the stored id and it must still be the same recording.
 * The caller compares `revision` to say whether that note was edited after the
 * link was made.
 */
export function resolveNoteOrigin(
  value: unknown,
  notes: unknown,
): NoteOriginResolution {
  const origin = noteOriginOf(value);
  if (!origin || !Array.isArray(notes)) return { status: "missing" };
  const matches = notes.filter(
    (note: { id?: unknown } | null) => note && note.id === origin.noteId,
  );
  if (matches.length !== 1) return { status: "missing" };
  const note = matches[0] as Record<string, unknown> & {
    audio?: { audioId?: unknown };
  };
  if (!note.audio || note.audio.audioId !== origin.audioId) {
    return { status: "missing" };
  }
  return { status: "found", origin, note };
}
