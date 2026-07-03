/**
 * Shared helpers for the meeting actions: message-text extraction and meeting
 * URL discovery from planner options or free text. Validated planner params
 * arrive nested under `options.parameters` on the real planner path (see
 * repo gotcha: top-level reads only work in direct-handler tests), so option
 * lookups check both levels.
 */

import type { Memory } from "@elizaos/core";
import { type ParsedMeetingUrl, parseMeetingUrl } from "@elizaos/shared";

export function messageText(message: Memory | null | undefined): string {
  const content = message?.content;
  if (!content) return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** Read a string option, checking both `options.<key>` and `options.parameters.<key>`. */
export function optionString(options: unknown, key: string): string | null {
  if (!options || typeof options !== "object") return null;
  const record = options as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const parameters = record.parameters;
  if (parameters && typeof parameters === "object") {
    const nested = (parameters as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Find the first recognizable meeting URL in free text. */
export function findMeetingUrlInText(text: string): ParsedMeetingUrl | null {
  for (const match of text.matchAll(URL_RE)) {
    const parsed = parseMeetingUrl(match[0].replace(/[.,;!?]+$/, ""));
    if (parsed) return parsed;
  }
  return null;
}

/** Resolve the meeting URL from an explicit option first, then message text. */
export function resolveMeetingUrl(
  message: Memory,
  options: unknown,
): ParsedMeetingUrl | null {
  const explicit =
    optionString(options, "meetingUrl") ?? optionString(options, "url");
  if (explicit) {
    const parsed = parseMeetingUrl(explicit);
    if (parsed) return parsed;
  }
  return findMeetingUrlInText(messageText(message));
}
