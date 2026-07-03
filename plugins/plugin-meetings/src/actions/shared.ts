/**
 * Shared helpers for the meeting actions: message-text extraction, meeting URL
 * discovery from planner options or free text, service lookup, session
 * targeting, and callback replies. Validated planner params arrive nested under
 * `options.parameters` on the real planner path (see repo gotcha: top-level
 * reads only work in direct-handler tests), so option lookups check both levels.
 */

import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
} from "@elizaos/core";
import {
  type MeetingSession,
  type ParsedMeetingUrl,
  parseMeetingUrl,
} from "@elizaos/shared";
import type { MeetingService } from "../service.js";

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

/**
 * Send the callback reply and return the matching `ActionResult` in one step —
 * collapses the `await callback?.({ text }); return { success, text }` boilerplate
 * every handler repeated.
 */
export async function reply(
  callback: HandlerCallback | undefined,
  success: boolean,
  text: string,
  data?: ProviderDataRecord,
): Promise<ActionResult> {
  await callback?.({ text });
  return data ? { success, text, data } : { success, text };
}

/**
 * Look up the meetings service. When it's running, `{ service }` is returned.
 * When it isn't, the given user-facing message is sent via the callback and
 * `{ bail }` carries the matching failure `ActionResult` for the handler to
 * return directly — preserving the exact not-running reply text.
 */
export async function requireMeetingService(
  runtime: IAgentRuntime,
  callback: HandlerCallback | undefined,
  notRunningText: string,
): Promise<{ service: MeetingService } | { bail: ActionResult }> {
  const service = runtime.getService<MeetingService>("meetings");
  if (service) return { service };
  return { bail: await reply(callback, false, notRunningText) };
}

/**
 * Pick the session an action should act on from an explicit sessionId, then a
 * meeting URL match, then a fallback. `fallback` differs per action:
 *  - `"single-or-ambiguous"` (LEAVE): the sole session, else `"ambiguous"`
 *    when several exist, else null — matches on-active-session lists.
 *  - `"most-recent"` (GET): the newest session (lists are newest-first), else null.
 *
 * A sessionId or URL that names no known session resolves to null (never the
 * fallback) so a wrong explicit target never silently hits the wrong meeting.
 */
export function resolveTargetSession(
  sessions: MeetingSession[],
  message: Memory,
  options: unknown,
  fallback: "single-or-ambiguous" | "most-recent",
): MeetingSession | "ambiguous" | null {
  const sessionId = optionString(options, "sessionId");
  if (sessionId) return sessions.find((s) => s.id === sessionId) ?? null;
  const parsed = resolveMeetingUrl(message, options);
  if (parsed) {
    return (
      sessions.find(
        (s) =>
          s.platform === parsed.platform &&
          s.nativeMeetingId === parsed.nativeMeetingId,
      ) ?? null
    );
  }
  if (fallback === "most-recent") return sessions[0] ?? null;
  if (sessions.length === 1) return sessions[0];
  return sessions.length === 0 ? null : "ambiguous";
}
