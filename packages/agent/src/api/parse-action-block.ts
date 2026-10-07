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

/**
 * End index (exclusive) of the JSON object that starts at `open`, or null
 * when that `{` does not begin a parseable object. Braces inside strings,
 * including escaped quotes, do not close the object. A regex that stops at
 * the first `}` drops `{"response":"use } here"}` and never runs the action.
 */
function readJsonObject(
  text: string,
  open: number,
): { end: number; value: unknown } | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          return { end: i + 1, value: JSON.parse(text.slice(open, i + 1)) };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function skipFenceWhitespace(text: string, index: number): number {
  let cursor = index;
  let count = 0;
  while (cursor < text.length && count < 33 && /\s/.test(text[cursor] ?? "")) {
    cursor++;
    count++;
  }
  return cursor;
}

interface ActionSpan {
  start: number;
  end: number;
  value: Record<string, unknown> & { action: string };
}

function findFencedActionSpans(text: string): ActionSpan[] {
  const spans: ActionSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("```", cursor);
    if (open < 0) break;
    let body = open + 3;
    if (text.startsWith("json", body)) body += 4;
    body = skipFenceWhitespace(text, body);
    const object = text[body] === "{" ? readJsonObject(text, body) : null;
    if (!object || !isValidActionEnvelope(object.value)) {
      cursor = open + 3;
      continue;
    }
    const close = skipFenceWhitespace(text, object.end);
    if (!text.startsWith("```", close)) {
      cursor = open + 3;
      continue;
    }
    spans.push({
      start: open,
      end: close + 3,
      value: object.value,
    });
    cursor = close + 3;
  }
  return spans;
}

function findBareActionSpans(
  text: string,
  covered: ActionSpan[],
): ActionSpan[] {
  const spans: ActionSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    if (
      covered.some((span) => i >= span.start && i < span.end) ||
      spans.some((span) => i >= span.start && i < span.end)
    ) {
      continue;
    }
    const object = readJsonObject(text, i);
    if (!object || !isValidActionEnvelope(object.value)) continue;
    spans.push({ start: i, end: object.end, value: object.value });
    i = object.end - 1;
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
  const fenced = findFencedActionSpans(safeText);
  const spans = [...fenced, ...findBareActionSpans(safeText, fenced)].sort(
    (left, right) => right.start - left.start,
  );
  let cleaned = safeText;
  for (const span of spans) {
    cleaned = cleaned.slice(0, span.start) + cleaned.slice(span.end);
  }
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
  const fenced = findFencedActionSpans(safeText);
  const span = fenced[0] ?? findBareActionSpans(safeText, fenced)[0];
  if (!span) return null;
  return toCoordinationResponse(span.value);
}
