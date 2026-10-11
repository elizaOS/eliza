/** Closed, provider-neutral selected Notes contract. Observations grant no authority. */
export const NOTES_CAPABILITY = "notes.local-record.v1";
export interface NotesTarget {
  sourceId: string;
  sourceRevision: string;
  noteId: string;
  revision: string;
}
export interface NotesFields {
  title: string;
  body: string;
}
export type NotesOperation =
  | { type: "notes_read_selected" | "notes_delete"; target: NotesTarget }
  | { type: "notes_update"; target: NotesTarget; fields: NotesFields };
export interface NotesResult {
  version: 1;
  kind: NotesOperation["type"];
  sourceId: string;
  noteId: string;
  revision: string;
  fields?: NotesFields;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Notes object");
  return value as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, names: string[]) {
  if (
    Object.keys(v).length !== names.length ||
    names.some((k) => !Object.hasOwn(v, k))
  )
    throw Error("Unexpected Notes fields");
}
function text(v: unknown, max: number, empty = false) {
  if (
    typeof v !== "string" ||
    v.length > max ||
    (!empty && !v.trim()) ||
    v.includes("\0")
  )
    throw Error("Invalid Notes text");
  return v;
}
function id(v: unknown) {
  const s = text(v, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s))
    throw Error("Invalid Notes identity");
  return s;
}
function revision(v: unknown) {
  const s = text(v, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw Error("Invalid Notes revision");
  return s;
}
export function notesFields(value: unknown): NotesFields {
  const v = object(value);
  keys(v, ["title", "body"]);
  const fields = {
    title: text(v.title, 256, true),
    body: text(v.body, 32000, true),
  };
  if (new TextEncoder().encode(JSON.stringify(fields)).byteLength > 60000)
    throw Error("Note text exceeds the reviewed transfer bound");
  return fields;
}
export function notesTarget(value: unknown): NotesTarget {
  const v = object(value);
  keys(v, ["sourceId", "sourceRevision", "noteId", "revision"]);
  return {
    sourceId: id(v.sourceId),
    sourceRevision: revision(v.sourceRevision),
    noteId: id(v.noteId),
    revision: revision(v.revision),
  };
}
export function isNotesOperation(value: unknown): value is NotesOperation {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    ["notes_read_selected", "notes_update", "notes_delete"].includes(
      String((value as { type?: unknown }).type),
    )
  );
}
export function validateNotesOperation(value: unknown): NotesOperation {
  const v = object(value);
  if (!isNotesOperation(value)) throw Error("Unsupported Notes operation");
  keys(
    v,
    value.type === "notes_update"
      ? ["type", "target", "fields"]
      : ["type", "target"],
  );
  return value.type === "notes_update"
    ? {
        type: value.type,
        target: notesTarget(v.target),
        fields: notesFields(v.fields),
      }
    : { type: value.type, target: notesTarget(v.target) };
}
export function validateNotesResult(
  operation: NotesOperation,
  value: unknown,
): NotesResult {
  const v = object(value);
  keys(
    v,
    operation.type === "notes_read_selected"
      ? ["version", "kind", "sourceId", "noteId", "revision", "fields"]
      : ["version", "kind", "sourceId", "noteId", "revision"],
  );
  if (
    v.version !== 1 ||
    v.kind !== operation.type ||
    v.sourceId !== operation.target.sourceId ||
    v.noteId !== operation.target.noteId
  )
    throw Error("Notes result scope changed");
  const result: NotesResult = {
    version: 1,
    kind: operation.type,
    sourceId: id(v.sourceId),
    noteId: id(v.noteId),
    revision: revision(v.revision),
  };
  if (
    operation.type !== "notes_update" &&
    result.revision !== operation.target.revision
  )
    throw Error("Notes result revision changed");
  if (operation.type === "notes_read_selected")
    result.fields = notesFields(v.fields);
  return result;
}
