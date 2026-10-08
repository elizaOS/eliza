/** Foreground local discovery; criteria never authorize an eager collection upload. */
export const NOTES_QUERY_CAPABILITY = "notes.query.v1";
export type NativeNotesQueryOperation = {
  type: "notes_query";
  query:
    | { kind: "title"; text: string }
    | { kind: "latest"; by: "created" | "updated" };
};
export function isNativeNotesQuery(value: {
  type: string;
}): value is NativeNotesQueryOperation {
  return value.type === "notes_query";
}
export function validateNativeNotesQuery(
  value: unknown,
): NativeNotesQueryOperation {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid Notes query");
    return value as Record<string, unknown>;
  };
  const exact = (value: Record<string, unknown>, keys: string[]) => {
    if (
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))
    )
      throw Error("Unexpected Notes query fields");
  };
  const operation = object(value);
  exact(operation, ["type", "query"]);
  if (operation.type !== "notes_query")
    throw Error("Invalid Notes query operation");
  const query = object(operation.query);
  if (query.kind === "title") {
    exact(query, ["kind", "text"]);
    if (
      typeof query.text !== "string" ||
      !query.text.trim() ||
      query.text.length > 256 ||
      query.text.includes("\0")
    )
      throw Error("A Notes title query is required");
    return { type: "notes_query", query: { kind: "title", text: query.text } };
  }
  if (query.kind === "latest") {
    exact(query, ["kind", "by"]);
    if (query.by !== "created" && query.by !== "updated")
      throw Error("Choose latest created or updated");
    return { type: "notes_query", query: { kind: "latest", by: query.by } };
  }
  throw Error("Unsupported Notes query");
}
