import type {
  ActionParameterSchema,
  JSONSchema,
} from "@elizaos/core/schema-types";
import {
  type AuthoredNoteContent,
  type AuthoredNoteEdit,
  projectAuthoredNoteContent,
} from "./note-authored.js";
/**
 * Shared domain contracts for the managed Cloud Notes view. The backend store,
 * authenticated routes, capability broker, and view bundle all consume these
 * shapes so persisted state has one owner and one schema instead of parallel
 * browser/server models.
 */

export const NOTES_SCHEMA_VERSION = 3 as const;

export const STICKY_COLORS = ["yellow", "green", "rose", "slate"] as const;

export type StickyColor = (typeof STICKY_COLORS)[number];

export type NoteJson =
  | null
  | boolean
  | number
  | string
  | NoteJson[]
  | { [key: string]: NoteJson };
/** Opaque authored rich fields remain lossless; the owning renderer validates its subtype. */
export interface NoteFormat {
  kind: "text" | "list" | "voice" | "link";
  data: { [key: string]: NoteJson };
}
export interface TrashedNote {
  note: StickyNote;
  deletedAt: string;
}
export interface StickyNote {
  id: string;
  title: string;
  body: string;
  color: StickyColor;
  format?: NoteFormat;
  createdAt: string;
  updatedAt: string;
}

export interface NotesSnapshot {
  notes: StickyNote[];
  revision: number;
  trash?: TrashedNote[];
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
  format?: NoteFormat;
  title: string;
  body: string;
  color: StickyColor;
}

/** Append carries only the exact suffix; old content stays inside the transaction. */
export type NoteTextEdit =
  | {
      action?: "replace";
      field: "title" | "body";
      oldText: string;
      newText: string;
    }
  | { action: "append"; field: "body"; text: string };

/** Shared model/capability schema; parseUpdateNoteInput owns runtime checks. */
export const noteTextEditSchema: ActionParameterSchema & JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["replace"] },
        field: { type: "string", enum: ["title", "body"] },
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
      },
      required: ["field", "oldText", "newText"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["append"] },
        field: { type: "string", enum: ["body"] },
        text: { type: "string", minLength: 1, maxLength: 20001 },
      },
      required: ["action", "field", "text"],
      additionalProperties: false,
    },
  ],
};

export interface UpdateNoteInput {
  authoredEdit?: AuthoredNoteEdit;
  format?: NoteFormat;
  content?: string;
  title?: string;
  body?: string;
  color?: StickyColor;
  textEdit?: NoteTextEdit;
}

/** Schema 2 stores the separator, if any, in the verbatim remainder. */
export function reconstructNoteContent(
  note: Pick<StickyNote, "title" | "body"> & { bodySeparator?: "" | "\n" },
): string {
  return note.title + (note.bodySeparator ?? "") + note.body;
}

/** Lossless model parts: remove only the codec's one framing LF, never authored whitespace. */
export function projectNoteForModel<
  T extends Pick<StickyNote, "title" | "body">,
>(
  note: T,
): Pick<StickyNote, "title" | "body"> & {
  bodySeparator: "" | "\n";
  id?: string;
  color?: StickyColor;
  createdAt?: string;
  updatedAt?: string;
  kind?: NoteFormat["kind"];
  authored?: AuthoredNoteContent;
} {
  const bodySeparator = note.body.startsWith("\n") ? "\n" : "";
  const record = note as T & Partial<StickyNote>;
  // Model-visible whitelist: authored text + canonical identity/time/color only.
  // Persisted rich metadata may contain local audio/source/attachment handles.
  return {
    title: note.title,
    body: bodySeparator ? note.body.slice(1) : note.body,
    bodySeparator,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(record.color === undefined ? {} : { color: record.color }),
    ...(typeof record.createdAt === "string"
      ? { createdAt: record.createdAt }
      : {}),
    ...(typeof record.updatedAt === "string"
      ? { updatedAt: record.updatedAt }
      : {}),
    ...(record.format ? { kind: record.format.kind } : {}),
    ...(projectAuthoredNoteContent(record.format)
      ? { authored: projectAuthoredNoteContent(record.format) }
      : {}),
  };
}
