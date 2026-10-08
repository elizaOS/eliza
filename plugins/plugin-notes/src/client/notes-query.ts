import type { NativeNotesQueryOperation } from "@elizaos/contracts/native-notes-query";
import type { NoteRecord } from "./notes-store.ts";
export interface LocalNotesQuery {
  basis:
    | "title-match"
    | "latest-created"
    | "latest-updated"
    | "only-note"
    | "owner-choice-uncertain";
  candidates: NoteRecord[];
  explanation: string;
}
/** Unknown legacy chronology remains unknown. Candidate records stay on the owning client. */
export function queryLocalNotes(
  records: NoteRecord[],
  query: NativeNotesQueryOperation["query"],
): LocalNotesQuery {
  if (query.kind === "title") {
    const text = query.text.normalize("NFKC").trim().toLowerCase();
    const candidates = records.filter((note) =>
      note.title.normalize("NFKC").toLowerCase().includes(text),
    );
    return {
      basis: "title-match",
      candidates,
      explanation:
        candidates.length > 1
          ? "Several notes match. Choose the one to share."
          : "Review the matching note before sharing it.",
    };
  }
  if (records.length === 1)
    return {
      basis: "only-note",
      candidates: records,
      explanation: "This is the only saved note. Review it before sharing.",
    };
  const instant = (value: unknown): number | undefined => {
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      Number.isFinite(new Date(value).getTime())
    )
      return value;
    if (
      typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().replace(".000Z", "Z") ===
        value.replace(".000Z", "Z")
    )
      return Date.parse(value);
    return undefined;
  };
  const times = records.map((note) =>
    query.by === "created"
      ? instant(note.createdAt)
      : instant(note.modifiedAt ?? note.updatedAt),
  );
  if (times.some((value) => value === undefined))
    return {
      basis: "owner-choice-uncertain",
      candidates: records,
      explanation:
        "Some saved notes have unknown dates, so the latest note cannot be verified. Choose the note to share.",
    };
  const maximum = Math.max(...(times as number[])),
    candidates = records.filter((_, index) => times[index] === maximum);
  if (candidates.length > 1)
    return {
      basis: "owner-choice-uncertain",
      candidates,
      explanation:
        "These notes share the latest recorded time. Choose the note to share.",
    };
  return {
    basis: query.by === "created" ? "latest-created" : "latest-updated",
    candidates,
    explanation: `Review the latest ${query.by} note before sharing.`,
  };
}
