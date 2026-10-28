import type { NoteFormat, NoteJson } from "./types.js";
export type AuthoredNotePart = { index: number; text: string; done?: boolean };
export type AuthoredNoteContent = {
  items?: AuthoredNotePart[];
  lines?: AuthoredNotePart[];
  summary?: string[];
  actions?: AuthoredNotePart[];
  clips?: string[];
};
const record = (value: NoteJson): value is { [key: string]: NoteJson } =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Exact renderer-authored fields only. Never includes speaker IDs, audio, source or attachment handles. */
export function projectAuthoredNoteContent(
  format: NoteFormat | undefined,
): AuthoredNoteContent | undefined {
  if (!format) return;
  const data = format.data;
  const parts = (
    field: string,
    check: boolean,
  ): AuthoredNotePart[] | undefined =>
    Array.isArray(data[field])
      ? data[field].flatMap((item, index) =>
          record(item) && typeof item.t === "string"
            ? [
                {
                  index,
                  text: item.t,
                  ...(check && typeof item.done === "boolean"
                    ? { done: item.done }
                    : {}),
                },
              ]
            : [],
        )
      : undefined;
  const strings = (field: string): string[] | undefined =>
    Array.isArray(data[field])
      ? data[field].filter((v): v is string => typeof v === "string")
      : undefined;
  if (format.kind === "list") {
    const items = parts("items", true);
    return items ? { items } : undefined;
  }
  if (format.kind === "voice") {
    const lines = parts("lines", false),
      summary = strings("summary"),
      actions = parts("actions", true);
    return {
      ...(lines ? { lines } : {}),
      ...(summary ? { summary } : {}),
      ...(actions ? { actions } : {}),
    };
  }
  if (format.kind === "link") {
    const clips = strings("clips");
    return clips ? { clips } : undefined;
  }
}
/** Search uses authored strings, never format metadata or internal handles. */
export function authoredNoteText(format: NoteFormat | undefined): string {
  const value = projectAuthoredNoteContent(format);
  if (!value) return "";
  return [
    ...(value.items ?? []).map((x) => x.text),
    ...(value.lines ?? []).map((x) => x.text),
    ...(value.summary ?? []),
    ...(value.actions ?? []).map((x) => x.text),
    ...(value.clips ?? []),
  ].join("\n");
}
export type AuthoredNoteEdit =
  | {
      action?: "replace";
      field:
        | "checklist"
        | "voice-line"
        | "voice-summary"
        | "voice-action"
        | "link-clip";
      index: number;
      expectedText: string;
      text?: string;
      done?: boolean;
    }
  | { field: "checklist"; action: "append"; text: string };
/** Replacements bind index + exact old text. Appends add one unchecked item.
 * The service collection revision binds both operations to the current read. */
export function editAuthoredNoteFormat(
  format: NoteFormat | undefined,
  edit: AuthoredNoteEdit,
): NoteFormat {
  if (edit.action === "append") {
    if (!format || format.kind !== "list" || !Array.isArray(format.data.items))
      throw Error("Checklist append requires the current list format.");
    if (!edit.text.trim())
      throw Error("Checklist append requires nonblank authored text.");
    const next = structuredClone(format);
    (next.data.items as NoteJson[]).push({ t: edit.text, done: false });
    return next;
  }
  const config = {
    checklist: ["list", "items", true],
    "voice-line": ["voice", "lines", false],
    "voice-summary": ["voice", "summary", false],
    "voice-action": ["voice", "actions", true],
    "link-clip": ["link", "clips", false],
  } as const;
  const [kind, key, check] = config[edit.field];
  if (!format || format.kind !== kind)
    throw Error("Rich note format changed; re-read before editing.");
  const next = structuredClone(format),
    rows = next.data[key];
  if (!Array.isArray(rows) || edit.index >= rows.length)
    throw Error("Authored note field changed; re-read before editing.");
  const item = rows[edit.index],
    text = typeof item === "string" ? item : record(item) ? item.t : undefined;
  if (typeof text !== "string" || text !== edit.expectedText)
    throw Error("Authored note text changed; nothing was edited.");
  if (edit.done !== undefined && !check)
    throw Error("This authored field has no checklist state.");
  if (typeof item === "string") {
    if (edit.text !== undefined) rows[edit.index] = edit.text;
  } else if (record(item)) {
    if (edit.text !== undefined) item.t = edit.text;
    if (edit.done !== undefined) item.done = edit.done;
  }
  return next;
}
