/** Editable Notes drafts shared by hosts. Mutations stay in the canonical service. */

import { authoredNoteText } from "../note-authored.js";
import { parseNoteFormat } from "../note-format.js";
import {
  type NoteFormat,
  projectNoteForModel,
  reconstructNoteContent,
  type StickyNote,
} from "../types.js";
import type { NotesController } from "./notes-controller.js";
export interface NoteEditorDraft {
  token: string;
  id?: string;
  baseRevision: number;
  version: number;
  title: string;
  body: string;
  separator: "" | "\n";
  framing: "verbatim" | "fields";
  format?: NoteFormat;
  color: StickyNote["color"];
}
/** Retain canonical authored separator bytes. A new pair of separate UI
 * fields gets one framing LF independent of which input was edited first. */
function editorFields(
  note: StickyNote,
): Pick<NoteEditorDraft, "title" | "body" | "separator" | "framing"> {
  const parts = projectNoteForModel(note);
  return {
    title: parts.title,
    body: parts.body,
    separator: parts.bodySeparator,
    framing:
      parts.bodySeparator === "\n" || parts.body !== "" ? "verbatim" : "fields",
  };
}
export interface NotesEditorHooks {
  changed(draft: NoteEditorDraft | null): void;
  committed(target: { id: string; revision: number }, draftToken: string): void;
  review(): void;
}
export class NotesEditor {
  private value: NoteEditorDraft | null = null;
  private saving = false;
  private queuedVersion: number | null = null;
  constructor(
    private readonly controller: NotesController,
    private readonly hooks: NotesEditorHooks,
  ) {}
  get draft(): NoteEditorDraft | null {
    return this.value ? structuredClone(this.value) : null;
  }
  get hasAuthoredContent(): boolean {
    const value = this.value;
    return (
      !!value &&
      (reconstructNoteContent({
        title: value.title,
        body: value.body,
        bodySeparator: value.separator,
      }).trim() !== "" ||
        authoredNoteText(value.format).trim() !== "")
    );
  }
  private show(): void {
    this.hooks.changed(this.draft);
  }
  open(id: string): void {
    if (this.value?.id === id) return;
    const revision = this.controller.revision,
      note = this.controller.viewNote(id);
    if (revision === null || !note)
      throw Error("Reload the current canonical note before editing.");
    this.value = {
      token: crypto.randomUUID(),
      id: note.id,
      baseRevision: revision,
      version: 0,
      ...editorFields(note),
      format: note.format ? structuredClone(note.format) : undefined,
      color: note.color,
    };
    this.show();
  }
  begin(kind: NoteFormat["kind"] = "text"): void {
    const revision = this.controller.revision;
    if (revision === null) throw Error("Open canonical Notes first.");
    this.value = {
      token: crypto.randomUUID(),
      baseRevision: revision,
      version: 0,
      title: "",
      body: "",
      separator: "",
      framing: "fields",
      ...(kind === "text" ? {} : { format: { kind, data: {} } }),
      color: "yellow",
    };
    this.show();
  }
  /** One explicit editor patch, not a collection diff. Unknown JSON fields remain
   * in format.data and shared parseNoteFormat owns its domain validation. */
  edit(patch: {
    title?: string;
    body?: string;
    format?: NoteFormat;
    color?: StickyNote["color"];
  }): void {
    const value = this.value;
    if (!value) throw Error("Select a canonical note first.");
    if (
      (patch.title !== undefined && typeof patch.title !== "string") ||
      (patch.body !== undefined && typeof patch.body !== "string")
    )
      throw Error("Unsupported editor text.");
    this.value = {
      ...value,
      ...patch,
      ...(patch.format ? { format: parseNoteFormat(patch.format) } : {}),
      version: value.version + 1,
    };
    if (this.value.framing === "fields")
      this.value.separator =
        this.value.title !== "" && this.value.body !== "" ? "\n" : "";
    this.show();
  }
  /** Preserve a dirty draft on external collection changes. A stale collection
   * revision is a conflict, never permission to overwrite a newer agent edit. */
  async save(): Promise<boolean> {
    const current = this.value;
    if (!current || !this.controller.current) return false;
    if (this.saving) {
      this.queuedVersion = current.version;
      return false;
    }
    if (this.controller.revision !== current.baseRevision) {
      this.hooks.review();
      return false;
    }
    const captured = structuredClone(current),
      content = reconstructNoteContent({
        title: captured.title,
        body: captured.body,
        bodySeparator: captured.separator,
      });
    if (!content.trim() && !authoredNoteText(captured.format).trim()) {
      if (captured.id) this.hooks.review();
      return false;
    } // Shared authored-rich semantics; no invented title or body mirror.
    this.saving = true;
    let confirmed = false;
    try {
      const result = await this.controller.interact(
        captured.id ? "update-note" : "create-note",
        {
          ...(captured.id
            ? { id: captured.id, expectedRevision: captured.baseRevision }
            : {}),
          content,
          color: captured.color,
          ...(captured.format ? { format: captured.format } : {}),
        },
      );
      if (!result.note || !result.target)
        throw Error("Canonical mutation identity is unavailable.");
      confirmed = true;
      if (this.value?.token === captured.token) {
        const changed = this.value.version !== captured.version;
        this.value = changed
          ? {
              ...this.value,
              id: result.note.id,
              baseRevision: result.target.revision,
            }
          : {
              ...this.value,
              id: result.note.id,
              baseRevision: result.target.revision,
              version: 0,
              ...editorFields(result.note),
              format: result.note.format
                ? structuredClone(result.note.format)
                : undefined,
              color: result.note.color,
            };
        this.show();
        this.hooks.committed(result.target, captured.token);
      }
      return true;
    } catch {
      if (this.controller.current) this.hooks.review();
      return false;
    } finally {
      this.saving = false;
      // A new owner input during the successful write is another edit, not a retry.
      const queued = this.queuedVersion;
      this.queuedVersion = null;
      if (
        confirmed &&
        this.value?.token === captured.token &&
        queued !== null &&
        queued > captured.version &&
        this.controller.current
      )
        void this.save();
    }
  }
  /** A clean open editor follows the same canonical collection. Dirty text
   * stays in its owner draft and requires review after an external revision. */
  reconcile(): void {
    const draft = this.value,
      revision = this.controller.revision;
    if (!draft?.id || revision === null || this.saving) return;
    if (draft.version > 0) {
      if (draft.baseRevision !== revision) this.hooks.review();
      return;
    }
    const note = this.controller.viewNote(draft.id);
    if (!note) {
      this.close();
      return;
    }
    this.value = {
      ...draft,
      baseRevision: revision,
      ...editorFields(note),
      format: note.format ? structuredClone(note.format) : undefined,
      color: note.color,
    };
    this.show();
  }
  close(): void {
    this.value = null;
    this.queuedVersion = null;
    this.show();
  }
  async remove(id: string): Promise<boolean> {
    let snapshot = this.controller.snapshot;
    if (!snapshot?.notes.some((note) => note.id === id) || this.saving)
      return false;
    const draft = this.value;
    if (draft?.id === id && draft.version > 0) {
      if (!(await this.save()) || this.value?.token !== draft.token)
        return false;
      snapshot = this.controller.snapshot;
      if (!snapshot?.notes.some((note) => note.id === id)) return false;
    }
    try {
      const result = await this.controller.interact("delete-note", { id });
      if (!result.target || result.target.id !== id) return false;
      if (this.value?.id === id) this.close();
      return true;
    } catch {
      if (this.controller.current) this.hooks.review();
      return false;
    }
  }
  async restore(id: string): Promise<boolean> {
    const snapshot = this.controller.snapshot;
    if (!snapshot?.trash?.some((entry) => entry.note.id === id) || this.saving)
      return false;
    try {
      const result = await this.controller.interact("restore-note", {
        id,
        expectedRevision: snapshot.revision,
      });
      return result.target?.id === id;
    } catch {
      if (this.controller.current) this.hooks.review();
      return false;
    }
  }
  selection():
    | { kind: "canonical-note"; id: string; revision: string }
    | undefined {
    const draft = this.value,
      revision = this.controller.revision;
    if (
      !draft?.id ||
      revision === null ||
      (draft.version > 0 && draft.baseRevision !== revision) ||
      !this.controller.hasViewNote(draft.id)
    )
      return;
    return { kind: "canonical-note", id: draft.id, revision: String(revision) };
  }
}
