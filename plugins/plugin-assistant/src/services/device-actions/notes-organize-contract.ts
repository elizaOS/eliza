/** Phone Notes organisation operations: list filter, folders, move, restore and voice recording.
 * This contract is browser-safe. The bounds mirror the phone's own validation, which rejects
 * values that exceed them.
 *
 * `notes_filter` only changes what the phone's Notes list shows and returns no note content.
 * `notes_record` starts or stops a voice note in the open Notes view. Both may run directly when
 * the owner's own current message asked for them; otherwise they are reviewed. Moving a note,
 * creating a folder and restoring from Recently deleted change saved data, so the owner reviews
 * each first. A move is bound to the reviewed note revision. Folders are addressed by name, never
 * by internal id. */
import { canonicalNotesListContextAllowed } from "@elizaos/contracts";
import { type NotesTarget, notesTarget } from "./notes-contract.ts";

export const NOTES_ORGANIZE_CAPABILITY = "notes.organize.v1";
export const NOTES_KINDS = ["text", "list", "voice", "link"] as const;
export type NotesKind = (typeof NOTES_KINDS)[number];
export const NOTES_FOLDER_NAME_MAX = 40;
export const NOTES_FILTER_TEXT_MAX = 200;

export type NotesOrganizeOperation =
  | { type: "notes_filter"; text?: string; folder?: string; kind?: NotesKind }
  | { type: "notes_list_filter"; text?: string; kind?: NotesKind }
  | { type: "notes_move"; target: NotesTarget; folder: string | null }
  | { type: "notes_folder_create"; name: string }
  | { type: "notes_restore"; noteId: string }
  | { type: "notes_record"; action: "start" | "stop" };
export type NotesOrganizeType = NotesOrganizeOperation["type"];

export const NOTES_ORGANIZE_TYPES: readonly NotesOrganizeType[] = [
  "notes_filter",
  "notes_list_filter",
  "notes_move",
  "notes_folder_create",
  "notes_restore",
  "notes_record",
];
/** May run without a review only when bound to the owner's own current message. */
export const NOTES_ORGANIZE_DIRECT_TYPES: readonly NotesOrganizeType[] = [
  "notes_filter",
  "notes_list_filter",
  "notes_record",
];

export function isNotesOrganizeType(type: unknown): type is NotesOrganizeType {
  return (NOTES_ORGANIZE_TYPES as readonly unknown[]).includes(type);
}
export function isNotesOrganizeOperation(
  value: unknown,
): value is NotesOrganizeOperation {
  return (
    !!value &&
    typeof value === "object" &&
    isNotesOrganizeType((value as { type?: unknown }).type)
  );
}

function only(op: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(op))
    if (!keys.includes(key)) throw Error("Unexpected Notes field");
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw Error("Invalid Notes text");
  return value.trim();
}
/** A folder name: whitespace runs collapse to one space; empty or over 40 characters is refused. */
export function notesFolderName(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0"))
    throw Error("Invalid folder name");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > NOTES_FOLDER_NAME_MAX)
    throw Error("Invalid folder name");
  return name;
}

export function validateNotesOrganizeOperation(
  value: unknown,
): NotesOrganizeOperation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Notes operation");
  const op = value as Record<string, unknown>;
  if (op.type === "notes_filter" || op.type === "notes_list_filter") {
    only(
      op,
      op.type === "notes_filter"
        ? ["type", "text", "folder", "kind"]
        : ["type", "text", "kind"],
    );
    if (
      op.kind !== undefined &&
      !(NOTES_KINDS as readonly unknown[]).includes(op.kind)
    )
      throw Error("Invalid note kind");
    const out = {
      type: op.type,
      ...(op.text !== undefined
        ? { text: text(op.text, NOTES_FILTER_TEXT_MAX) }
        : {}),
      ...(op.folder !== undefined
        ? { folder: notesFolderName(op.folder) }
        : {}),
      ...(op.kind !== undefined ? { kind: op.kind as NotesKind } : {}),
    } as const;
    if (
      out.text === undefined &&
      out.folder === undefined &&
      out.kind === undefined
    )
      throw Error("Empty Notes filter");
    return out;
  }
  if (op.type === "notes_move") {
    only(op, ["type", "target", "folder"]);
    if (!Object.hasOwn(op, "folder")) throw Error("Missing folder");
    return {
      type: "notes_move",
      target: notesTarget(op.target),
      folder: op.folder === null ? null : notesFolderName(op.folder),
    };
  }
  if (op.type === "notes_folder_create") {
    only(op, ["type", "name"]);
    return { type: "notes_folder_create", name: notesFolderName(op.name) };
  }
  if (op.type === "notes_restore") {
    only(op, ["type", "noteId"]);
    const id = text(op.noteId, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))
      throw Error("Invalid note identity");
    return { type: "notes_restore", noteId: id };
  }
  if (op.type === "notes_record") {
    only(op, ["type", "action"]);
    if (op.action !== "start" && op.action !== "stop")
      throw Error("Invalid recording action");
    return { type: "notes_record", action: op.action };
  }
  throw Error("Unsupported Notes operation");
}

const quoted = (value: string) => `“${value}”`;
const KIND_LABELS: Record<NotesKind, string> = {
  text: "Notes",
  list: "Checklists",
  voice: "Voice notes",
  link: "Links",
};
/** The review card: the change itself, nothing else. */
export function describeNotesOrganizeOperation(op: NotesOrganizeOperation): {
  title: string;
  description: string;
} {
  if (op.type === "notes_filter" || op.type === "notes_list_filter")
    return {
      title: "Show notes",
      description: [
        op.text ? quoted(op.text) : "",
        op.kind ? KIND_LABELS[op.kind] : "",
        "folder" in op && op.folder ? `In ${op.folder}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  if (op.type === "notes_move")
    return {
      title: "Move note",
      description: op.folder === null ? "To no folder" : `To ${op.folder}`,
    };
  if (op.type === "notes_folder_create")
    return { title: "New folder", description: op.name };
  if (op.type === "notes_record")
    return op.action === "start"
      ? { title: "Record voice note", description: "In Notes" }
      : {
          title: "Stop recording",
          description: "Save as a voice note",
        };
  return { title: "Restore note", description: "From Recently deleted" };
}

/** Where a proposal may be reviewed or run: the unlocked phone on Home or in Notes; recording
 * only while the Notes view is open. */
export function notesOrganizeContextAllowed(
  context: Parameters<typeof canonicalNotesListContextAllowed>[0],
  operation?: Pick<NotesOrganizeOperation, "type">,
): boolean {
  if (context.sensitive) return false;
  if (operation?.type === "notes_list_filter")
    return canonicalNotesListContextAllowed(context);
  return operation?.type === "notes_record"
    ? context.view === "notes"
    : context.view === "home" || context.view === "notes";
}
