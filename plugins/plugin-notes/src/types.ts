/**
 * Shared domain contracts for the managed Cloud Notes view. The backend store,
 * authenticated routes, capability broker, and view bundle all consume these
 * shapes so persisted state has one owner and one schema instead of parallel
 * browser/server models.
 */

export const NOTES_SCHEMA_VERSION = 2 as const;

/**
 * The pre-`reconstructNoteContent` on-disk layout. A v1 note stored `body` as
 * the first line's newline-joined remainder with its leading separator trimmed,
 * so the retired view rebuilt content as `title + "\n" + body`. Loading such a
 * document migrates it to v2 (see `parseNotesDocument`), which stores `body` as
 * the verbatim remainder so `reconstructNoteContent` is a faithful inverse.
 */
export const NOTES_SCHEMA_VERSION_V1 = 1 as const;

export const STICKY_COLORS = ["yellow", "green", "rose", "slate"] as const;

export type StickyColor = (typeof STICKY_COLORS)[number];

export interface StickyNote {
  id: string;
  title: string;
  body: string;
  color: StickyColor;
  createdAt: string;
  updatedAt: string;
}

export interface NotesSnapshot {
  notes: StickyNote[];
  revision: number;
}

export interface NotesDocument extends NotesSnapshot {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  persistedAt: string;
}

export type NotesStorePhase =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "stopped";

export interface NotesStoreStatus {
  phase: NotesStorePhase;
  filePath: string;
  revision?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface CreateNoteInput {
  title: string;
  body: string;
  color: StickyColor;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  color?: StickyColor;
}

/**
 * Rebuild the single user-authored content field from its stored parts. This is
 * the exact inverse of `parseNoteContent`: the schema keeps `title` as the
 * derived first-line label (bounded for list lookup and the agent surface) and
 * `body` as the verbatim remainder, so plain concatenation returns exactly the
 * content the user wrote — including a blank line after the first line or a
 * first line longer than the label bound. Keep this the only reconstruction so
 * the view and the validators can never drift into re-corrupting content.
 */
export function reconstructNoteContent(
  parts: Pick<StickyNote, "title" | "body">,
): string {
  return `${parts.title}${parts.body}`;
}
