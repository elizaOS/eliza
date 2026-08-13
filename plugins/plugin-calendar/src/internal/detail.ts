/**
 * Normalizes loose action-detail records into typed primitives and parses model
 * JSON responses after removing common wrapper formats. Calendar action handlers
 * use these helpers at the LLM/runtime boundary so malformed details fail to
 * resolve instead of leaking weak casts through the event service.
 */
import type { Memory, ProviderDataRecord } from "@elizaos/core";

export const INTERNAL_URL = new URL("http://127.0.0.1/");

export function toActionData<T extends object>(data: T): ProviderDataRecord {
  const record: ProviderDataRecord = {};
  for (const [key, value] of Object.entries(data)) {
    record[key] = value as ProviderDataRecord[string];
  }
  return record;
}

export function messageText(message: Memory): string {
  const text = (message.content as Record<string, unknown> | undefined)?.text;
  return typeof text === "string" ? text : "";
}

export function detailString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function detailNumber(
  details: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function detailBoolean(
  details: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = details?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function detailArray(
  details: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  const value = details?.[key];
  return Array.isArray(value) ? value : undefined;
}

const MODEL_CODE_FENCE_PATTERN =
  /^\s*```(?:json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i;

function stripModelWrappers(raw: string): string {
  let candidate = raw.trim();
  const thinkEnd = candidate.indexOf("</think>");
  if (candidate.startsWith("<think>") && thinkEnd !== -1) {
    candidate = candidate.slice(thinkEnd + "</think>".length).trim();
  }
  const fenced = candidate.match(MODEL_CODE_FENCE_PATTERN);
  if (fenced) {
    candidate = (fenced[1] ?? "").trim();
  }
  return candidate;
}

export function parseCalendarJsonRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(raw: string): T | null {
  const candidate = stripModelWrappers(raw);
  if (candidate.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as T;
}

/**
 * Planner-authored calendarId carries the same junk problem as mode/side/
 * grantId: placeholder tokens ("default", "all", "none") that name no real
 * calendar. getCalendarFeed treats any non-empty calendarId as an explicit
 * source filter, so junk excludes every calendar and a create turn dies with
 * CALENDAR_MUTATION_CONTEXT_INCOMPLETE. Calendar ids have no whitelistable
 * shape (Google email-like ids and "primary", Microsoft/Apple opaque ids), so
 * this boundary drops the known placeholder vocabulary instead: unset yields
 * the aggregated feed and provider-default target — which is what the
 * placeholders meant. Real ids pass through untouched.
 */
const CALENDAR_ID_PLACEHOLDER_TOKENS = new Set([
  "default",
  "all",
  "none",
  "null",
  "unset",
  "unknown",
  "any",
  "auto",
]);

export function sanitizeCalendarId(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return CALENDAR_ID_PLACEHOLDER_TOKENS.has(trimmed.toLowerCase())
    ? undefined
    : trimmed;
}
