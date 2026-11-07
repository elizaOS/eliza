/** Exact Gmail text units, shared by cached and private-host reads. */
import { ElizaError, type ReadRangeUnit } from "@elizaos/core";

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export function gmailTextLines(text: string): string[] {
  if (!text) return [];
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
    result.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

export function gmailTextFragments(text: string): string[] {
  const fragments: string[] = [];
  let current = "";
  for (const line of gmailTextLines(text)) {
    current += line;
    if (line.replace(/[\r\n]/gu, "").trim().length === 0) {
      fragments.push(current);
      current = "";
    }
  }
  if (current) fragments.push(current);
  return fragments;
}

export function readGmailTextRange(
  text: string,
  unit: ReadRangeUnit,
  offset: number,
  limit?: number
) {
  if (
    !["byte", "line", "fragment"].includes(unit) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
  )
    throw new ElizaError("Invalid Gmail read range", { code: "GMAIL_READ_INVALID_RANGE" });
  const bytes = unit === "byte" ? encoder.encode(text) : undefined,
    values =
      unit === "line"
        ? gmailTextLines(text)
        : unit === "fragment"
          ? gmailTextFragments(text)
          : undefined;
  const total = bytes?.length ?? values!.length;
  if (offset > total)
    throw new ElizaError("Gmail read offset is past the end of the message", {
      code: "GMAIL_READ_OFFSET_OUT_OF_RANGE",
    });
  let end = limit === undefined ? total : Math.min(total, offset + limit);
  if (bytes) {
    if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
      throw new ElizaError("Gmail byte range splits a UTF-8 code point", {
        code: "GMAIL_READ_INVALID_UTF8_BOUNDARY",
      });
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === offset && offset < total)
      throw new ElizaError("Gmail byte limit is too small for the next UTF-8 code point", {
        code: "GMAIL_READ_LIMIT_SPLITS_CODE_POINT",
      });
    return { text: decoder.decode(bytes.subarray(offset, end)), start: offset, end, total, unit };
  }
  if (end === offset && offset < total)
    throw new ElizaError("Gmail read limit must advance", { code: "GMAIL_READ_INVALID_RANGE" });
  return { text: values!.slice(offset, end).join(""), start: offset, end, total, unit };
}
