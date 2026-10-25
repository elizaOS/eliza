import { ElizaError } from "@elizaos/core";
import { authoredNoteText, editAuthoredNoteFormat } from "./note-authored.js";
import type { StickyNote, UpdateNoteInput } from "./types.js";
import { parseNoteContent, parseStickyNote } from "./validation.js";

export function applyNotePatch(
  existing: StickyNote,
  patch: UpdateNoteInput,
  updatedAt: string,
): StickyNote {
  const updated: StickyNote = { ...existing, updatedAt };
  if (patch.authoredEdit) {
    try {
      return parseStickyNote({
        ...updated,
        format: editAuthoredNoteFormat(existing.format, patch.authoredEdit),
      });
    } catch (error) {
      throw new ElizaError(
        "Authored note edit conflicts with its current format or text.",
        { code: "NOTES_EDIT_CONFLICT", cause: error, severity: "ephemeral" },
      );
    }
  }
  if (
    existing.format &&
    existing.format.kind !== "text" &&
    authoredNoteText(existing.format) &&
    patch.format === undefined &&
    ((patch.content !== undefined && patch.content.trim() !== "") ||
      (patch.body !== undefined && patch.body.trim() !== "") ||
      patch.textEdit?.field === "body")
  )
    throw new ElizaError(
      "Use the current note's authoredEdit field and index for rich content; body replacement cannot edit a checklist or transcript.",
      { code: "NOTES_RICH_EDIT_REQUIRED", severity: "ephemeral" },
    );
  if (patch.textEdit) {
    const { field, oldText, newText } = patch.textEdit;
    const original = existing[field];
    const first = original.indexOf(oldText);
    const ambiguous = first >= 0 && original.indexOf(oldText, first + 1) >= 0;
    if (first < 0 || ambiguous) {
      throw new ElizaError(
        first < 0
          ? "The exact old text is absent from the current note; read it before choosing another edit. Nothing changed."
          : "The old text matches more than once; include enough surrounding text to identify one occurrence. Nothing changed.",
        {
          code:
            first < 0
              ? "NOTES_EDIT_TEXT_NOT_FOUND"
              : "NOTES_EDIT_TEXT_AMBIGUOUS",
          context: { noteId: existing.id, field },
          severity: "ephemeral",
        },
      );
    }
    // A replacement callback keeps $&, $1 and similar text literal. The
    // match is checked under the same store barrier that commits the update.
    const replacement = original.replace(oldText, () => newText);
    const validated = parseStickyNote({ ...updated, [field]: replacement });
    if (validated[field] !== replacement) {
      throw new ElizaError(
        "The exact edit would require whitespace normalization; nothing changed.",
        {
          code: "NOTES_EDIT_NORMALIZATION_REQUIRED",
          context: { noteId: existing.id, field },
          severity: "ephemeral",
        },
      );
    }
    updated[field] = replacement;
    return updated;
  }
  if (patch.content !== undefined) {
    Object.assign(
      updated,
      parseNoteContent(
        patch.content,
        "content",
        !!authoredNoteText(patch.format ?? existing.format).trim(),
      ),
    );
  } else {
    if (patch.title !== undefined) updated.title = patch.title;
    // Public structured bodies exclude the separator; stored remainders include it.
    if (patch.body !== undefined)
      updated.body = patch.body ? `\n${patch.body}` : "";
  }
  if (patch.format !== undefined)
    updated.format = structuredClone(patch.format);
  if (patch.color !== undefined) updated.color = patch.color;
  return updated;
}
