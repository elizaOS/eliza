import { ElizaError } from "@elizaos/core";
import { authoredNoteText, editAuthoredNoteFormat } from "./note-authored.js";
import type { StickyNote, UpdateNoteInput } from "./types.js";
import { parseNoteContent, parseStickyNote } from "./validation.js";

const LIST_MARKER = /^(\s*)(?:(\d+)([.)]\s+)|([-*+•]\s+)?(\[[ xX]\]\s+)?)/;
const LAST_LIST_DELIMITER = /([,;，；、،؛])(\s*)[^,;，；、،؛]*$/;

/** Suffix that adds one item in the body's own list form, leaving old text in
 * place: a bulleted, checkbox or numbered last line repeats its marker, a lone
 * delimited line repeats its last delimiter, anything else starts a new line. */
function listItemSuffix(body: string, item: string): string {
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const atLineStart = body === "" || /\n$/.test(body);
  const lines = body.split(/\r?\n/).filter((line) => line.trim());
  const last = lines.at(-1) ?? "";
  const marker = LIST_MARKER.exec(last);
  const prefix = marker?.[2]
    ? `${marker[1]}${Number(marker[2]) + 1}${marker[3]}`
    : marker?.[4] || marker?.[5]
      ? `${marker[1]}${marker[4] ?? ""}${marker[5]?.replace(/[xX]/, " ") ?? ""}`
      : "";
  const delimiter =
    !prefix && !atLineStart && lines.length === 1
      ? LAST_LIST_DELIMITER.exec(last)
      : null;
  if (delimiter) return `${delimiter[1]}${delimiter[2]}${item.trim()}`;
  return `${atLineStart && body ? "" : newline}${prefix}${item.trim()}`;
}

export function applyNotePatch(
  existing: StickyNote,
  patch: UpdateNoteInput,
  updatedAt: string,
): StickyNote {
  const updated: StickyNote = { ...existing, updatedAt };
  // A plain note keeps its list in text, so one new item is an exact body
  // suffix in that list's form (tj-792ca892257ad2), not a checklist conflict.
  const textEdit =
    patch.authoredEdit?.action === "append" &&
    (!existing.format || existing.format.kind === "text")
      ? {
          action: "append" as const,
          field: "body" as const,
          text: listItemSuffix(existing.body, patch.authoredEdit.text),
        }
      : patch.textEdit;
  if (patch.authoredEdit && !textEdit) {
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
    (authoredNoteText(existing.format) || textEdit?.action === "append") &&
    patch.format === undefined &&
    ((patch.content !== undefined && patch.content.trim() !== "") ||
      (patch.body !== undefined && patch.body.trim() !== "") ||
      textEdit?.field === "body")
  )
    throw new ElizaError(
      "Use the current note's authoredEdit field and index for rich content; body replacement cannot edit a checklist or transcript.",
      { code: "NOTES_RICH_EDIT_REQUIRED", severity: "ephemeral" },
    );
  if (textEdit) {
    const edit = textEdit;
    const { field } = edit;
    const original = existing[field];
    let replacement: string;
    if (edit.action === "append") {
      // The caller supplies the separator as part of the exact suffix.
      replacement = original + edit.text;
    } else {
      const { oldText, newText } = edit;
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
      // A callback keeps $&, $1 and similar text literal.
      replacement = original.replace(oldText, () => newText);
    }
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
