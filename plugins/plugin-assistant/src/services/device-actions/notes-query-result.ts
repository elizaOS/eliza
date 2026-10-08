import {
  type NativeNotesQueryOperation,
  validateNativeNotesQuery,
} from "@elizaos/contracts/native-notes-query";
import {
  type NotesResult,
  type NotesTarget,
  validateNotesOperation,
  validateNotesResult,
} from "./notes-contract.ts";

interface SelectedNotesQueryResult {
  version: 1;
  kind: "notes_query";
  query: NativeNotesQueryOperation["query"];
  basis:
    | "title-match"
    | "latest-created"
    | "latest-updated"
    | "only-note"
    | "owner-choice-uncertain";
  target: NotesTarget;
  record: NotesResult;
}
export type NotesQueryResult =
  | SelectedNotesQueryResult
  | {
      version: 1;
      kind: "notes_query";
      query: NativeNotesQueryOperation["query"];
      basis: "no-match";
    };
export function validateNotesQueryResult(
  operation: NativeNotesQueryOperation,
  value: unknown,
): NotesQueryResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Notes query receipt");
  const result = value as Record<string, unknown>;
  const fields =
    result.basis === "no-match"
      ? ["version", "kind", "query", "basis"]
      : ["version", "kind", "query", "basis", "target", "record"];
  if (
    Object.keys(result).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(result, key)) ||
    result.version !== 1 ||
    result.kind !== "notes_query"
  )
    throw Error("Invalid Notes query receipt fields");
  const query = validateNativeNotesQuery({
    type: "notes_query",
    query: result.query,
  }).query;
  if (JSON.stringify(query) !== JSON.stringify(operation.query))
    throw Error("Notes query changed");
  if (result.basis === "no-match")
    return { version: 1, kind: "notes_query", query, basis: "no-match" };
  const allowed =
    query.kind === "title"
      ? ["title-match"]
      : [`latest-${query.by}`, "only-note", "owner-choice-uncertain"];
  if (typeof result.basis !== "string" || !allowed.includes(result.basis))
    throw Error("Notes selection proof changed");
  const selected = validateNotesOperation({
    type: "notes_read_selected",
    target: result.target,
  });
  if (selected.type !== "notes_read_selected")
    throw Error("Invalid selected Notes read");
  const record = validateNotesResult(selected, result.record);
  return {
    version: 1,
    kind: "notes_query",
    query,
    basis: result.basis as SelectedNotesQueryResult["basis"],
    target: selected.target,
    record,
  };
}
