import { extractJsonObjectSpans } from "@elizaos/core/protocol";
/**
 * Local compatibility type for CoordinationLLMResponse — removed from
 * @elizaos/plugin-agent-orchestrator 2.x.
 */
export interface CoordinationLLMResponse {
  action: string;
  reasoning: string;
  response?: string;
  useKeys?: boolean;
  keys?: string[];
  /**
   * Set when `action === "permission_request"`. The chat renderer consumes
   * this payload to render an inline `<PermissionCard>` below the message.
   */
  permissionRequest?: ParsedPermissionRequest;
}

import {
  isPermissionId,
  type PermissionId,
  toWellFormedUnicode,
} from "@elizaos/core";

/**
 * Parsed shape for the `permission_request` action. The agent emits this
 * inline alongside its natural-language response; the chat surface renders
 * a permission card and (after grant) the agent retries the original action.
 */
export interface ParsedPermissionRequest {
  permission: PermissionId;
  reason: string;
  feature: string;
  fallbackOffered: boolean;
  fallbackLabel?: string;
}

/** Console bridge exposed by PTYService for terminal I/O. */
export interface ConsoleBridge {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  writeRaw(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
}

/** PTY service interface (accessed via runtime.getService). */
export interface PTYService {
  consoleBridge?: ConsoleBridge;
  listSessions?(): Array<{ sessionId: string; ownerClientId?: string }>;
  stopSession?(sessionId: string): Promise<void>;
}

const VALID_ACTIONS = [
  "respond",
  "escalate",
  "ignore",
  "complete",
  "permission_request",
];
const ACTION_KEYS = new Set([
  "action",
  "reasoning",
  "response",
  "useKeys",
  "keys",
  // permission_request fields
  "permission",
  "reason",
  "feature",
  "fallback_offered",
  "fallback_label",
]);

function isValidActionEnvelope(
  parsed: unknown,
): parsed is Record<string, unknown> & { action: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.action !== "string" ||
    !VALID_ACTIONS.includes(record.action)
  )
    return false;

  for (const key of Object.keys(record)) {
    if (!ACTION_KEYS.has(key)) return false;
  }

  if ("reasoning" in record && typeof record.reasoning !== "string")
    return false;

  if (record.action === "respond") {
    if (
      "permission" in record ||
      "feature" in record ||
      "fallback_offered" in record ||
      "fallback_label" in record ||
      "reason" in record
    ) {
      return false;
    }
    const hasResponse =
      typeof record.response === "string" && record.response.length > 0;
    const hasKeys =
      record.useKeys === true &&
      Array.isArray(record.keys) &&
      record.keys.length > 0;
    return hasResponse || hasKeys;
  }

  if (record.action === "permission_request") {
    if (!isPermissionId(record.permission)) return false;
    if (typeof record.reason !== "string" || record.reason.trim().length === 0)
      return false;
    if (
      typeof record.feature !== "string" ||
      record.feature.trim().length === 0
    )
      return false;
    if (
      "fallback_offered" in record &&
      typeof record.fallback_offered !== "boolean"
    )
      return false;
    if (
      "fallback_label" in record &&
      record.fallback_label !== undefined &&
      typeof record.fallback_label !== "string"
    )
      return false;
    if ("response" in record || "useKeys" in record || "keys" in record) {
      return false;
    }
    return true;
  }

  // Non-respond, non-permission_request actions should not carry
  // respond-only or permission_request fields.
  if (
    "response" in record ||
    "useKeys" in record ||
    "keys" in record ||
    "permission" in record ||
    "feature" in record ||
    "fallback_offered" in record ||
    "fallback_label" in record
  ) {
    return false;
  }
  // `reason` is reserved for permission_request only.
  if ("reason" in record) return false;
  return true;
}

/** Complete top-level JSON action and its optional Markdown fence. */
interface ActionSpan {
  start: number;
  end: number;
  fenced: boolean;
  value: Record<string, unknown> & { action: string };
}

function findActionSpans(text: string): ActionSpan[] {
  const spans: ActionSpan[] = [];
  let coveredEnd = 0;
  // Core owns quote/escape-aware object boundaries in prose. Never rescan
  // inside a rejected object or reinterpret its nested data as an action.
  for (const { start, end } of extractJsonObjectSpans(text)) {
    const json = text.slice(start, end);
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      // error-policy:J3 malformed model JSON remains ordinary display text.
      continue;
    }
    if (!isValidActionEnvelope(value)) continue;
    const prefix = text.slice(Math.max(0, start - 40), start);
    const opening = /```(?:json)?\s{0,33}$/.exec(prefix);
    const closing = /^\s{0,33}```/.exec(text.slice(end, end + 36));
    const fenceStart = start - (opening?.[0].length ?? 0);
    const fenced = Boolean(opening && closing && fenceStart >= coveredEnd);
    const span = {
      start: fenced ? fenceStart : start,
      end: fenced ? end + (closing?.[0].length ?? 0) : end,
      fenced,
      value: value as Record<string, unknown> & { action: string },
    };
    spans.push(span);
    coveredEnd = span.end;
  }
  return spans;
}

function toCoordinationResponse(
  parsed: Record<string, unknown> & { action: string },
): CoordinationLLMResponse | null {
  const result: CoordinationLLMResponse = {
    action: parsed.action,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
  };
  if (parsed.action === "respond") {
    if (parsed.useKeys && Array.isArray(parsed.keys)) {
      result.useKeys = true;
      result.keys = parsed.keys.map(String);
    } else if (typeof parsed.response === "string") {
      result.response = parsed.response;
    } else return null;
  }
  if (parsed.action === "permission_request") {
    const permission = parsed.permission;
    if (!isPermissionId(permission)) return null;
    const reason = String(parsed.reason ?? "");
    const feature = String(parsed.feature ?? "");
    const fallbackOffered = parsed.fallback_offered === true;
    const rawLabel = parsed.fallback_label;
    result.permissionRequest = {
      permission,
      reason,
      feature,
      fallbackOffered,
      ...(typeof rawLabel === "string" && rawLabel.length > 0
        ? { fallbackLabel: rawLabel }
        : {}),
    };
  }
  return result;
}

/**
 * Strip JSON action blocks from text before displaying in chat.
 * Handles both fenced (```json ... ```) and bare JSON formats.
 */
export function stripActionBlockFromDisplay(text: string): string {
  const safeText = toWellFormedUnicode(text);
  const chunks: string[] = [];
  let cursor = 0;
  for (const span of findActionSpans(safeText)) {
    chunks.push(safeText.slice(cursor, span.start));
    cursor = span.end;
  }
  chunks.push(safeText.slice(cursor));
  const cleaned = chunks.join("");
  return cleaned.trim();
}

/**
 * Parse a JSON action block from Eliza's natural language response.
 * Looks for a fenced ```json block first, then bare JSON with "action" key.
 * Returns null if no valid action block is found.
 */
export function parseActionBlock(text: string): CoordinationLLMResponse | null {
  if (!text) return null;
  const safeText = toWellFormedUnicode(text);
  const spans = findActionSpans(safeText);
  const span = spans.find((candidate) => candidate.fenced) ?? spans[0];
  if (!span) return null;
  return toCoordinationResponse(span.value);
}
