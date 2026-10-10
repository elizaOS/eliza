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

/** Correlation from the server-retained original request; never execution authority. */
export interface NativeNotesReadReplyOrigin {
  version: 1;
  requestId: string;
  conversationId: string;
  inReplyTo: string;
}
export interface NativeNotesReadReplyHint extends NativeNotesReadReplyOrigin {
  proposalId: string;
  digest: string;
  attemptId: string;
}
export interface NativeNotesReadReply extends NativeNotesReadReplyOrigin {
  messageId: string;
  text: string;
}
function readReplyObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid approved Notes reply");
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    throw Error("Unexpected approved Notes reply fields");
  return result;
}
function readReplyId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
    throw Error("Invalid approved Notes reply identity");
  return value;
}
function readReplyOrigin(
  value: Record<string, unknown>,
): NativeNotesReadReplyOrigin {
  if (value.version !== 1)
    throw Error("Unsupported approved Notes reply version");
  if (
    typeof value.requestId !== "string" ||
    value.requestId.trim() !== value.requestId ||
    !value.requestId ||
    value.requestId.length > 128 ||
    value.requestId.includes("\0")
  )
    throw Error("Invalid original request nonce");
  return {
    version: 1,
    requestId: value.requestId,
    conversationId: readReplyId(value.conversationId),
    inReplyTo: readReplyId(value.inReplyTo),
  };
}
export function validateNativeNotesReadReplyOrigin(
  value: unknown,
): NativeNotesReadReplyOrigin {
  return readReplyOrigin(
    readReplyObject(value, [
      "version",
      "requestId",
      "conversationId",
      "inReplyTo",
    ]),
  );
}
export function validateNativeNotesReadReplyHint(
  value: unknown,
): NativeNotesReadReplyHint {
  const result = readReplyObject(value, [
    "version",
    "requestId",
    "conversationId",
    "inReplyTo",
    "proposalId",
    "digest",
    "attemptId",
  ]);
  if (
    typeof result.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.digest)
  )
    throw Error("Invalid approved Notes reply digest");
  return {
    ...readReplyOrigin(result),
    proposalId: readReplyId(result.proposalId),
    digest: result.digest,
    attemptId: readReplyId(result.attemptId),
  };
}
export function validateNativeNotesReadReply(
  value: unknown,
): NativeNotesReadReply {
  const result = readReplyObject(value, [
    "version",
    "requestId",
    "conversationId",
    "inReplyTo",
    "messageId",
    "text",
  ]);
  if (
    typeof result.text !== "string" ||
    !result.text.trim() ||
    result.text.length > 65536 ||
    result.text.includes("\0")
  )
    throw Error("Invalid approved Notes reply text");
  return {
    ...readReplyOrigin(result),
    messageId: readReplyId(result.messageId),
    text: result.text,
  };
}
