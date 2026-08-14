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

/**
 * Small models on the native tool path emit key-name debris as field VALUES.
 * Two shapes show up live:
 *   a comma-led key fragment  — `",time_min:"`, `",label:"`, `",new_title:"`
 *   the field's own name      — `side: "side"`, `grantId: "grantId"`
 * Both type-check, so they flow into connector routing and event lookup as if
 * they were real input: a plain "cancel the quibbleworth review" arrived with
 * grantId="grantId", missed the built-in calendar, and the user was told
 * "Google Calendar isn't connected" about an event in their own local calendar.
 *
 * A value that is only a key fragment, or only its own field name, carries no
 * information in ANY calendar field — so it is dropped here, at the single
 * chokepoint every field reads through, rather than at each call site.
 */
const KEY_DEBRIS_PATTERN = /^,\s*[A-Za-z_][A-Za-z0-9_-]*\s*:?$/;

function echoesOwnKey(key: string, value: string): boolean {
  const normalize = (raw: string) => raw.replace(/[\s_-]+/g, "").toLowerCase();
  return normalize(value) === normalize(key);
}

export function detailString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    KEY_DEBRIS_PATTERN.test(trimmed) ||
    echoesOwnKey(key, trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

export type PlannerCalendarWindow = {
  timeMin: string;
  timeMax: string;
};

/**
 * Accepts a planner window only when both bounds parse and form a forward
 * interval. Returning the pair atomically prevents a valid half-window from
 * reaching the strict calendar-service boundary after its partner is dropped.
 */
export function normalizePlannerCalendarWindow(
  timeMin: unknown,
  timeMax: unknown,
): PlannerCalendarWindow | undefined {
  if (typeof timeMin !== "string" || typeof timeMax !== "string") {
    return undefined;
  }
  const minMs = Date.parse(timeMin.trim());
  const maxMs = Date.parse(timeMax.trim());
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs >= maxMs) {
    return undefined;
  }
  return {
    timeMin: new Date(minMs).toISOString(),
    timeMax: new Date(maxMs).toISOString(),
  };
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
