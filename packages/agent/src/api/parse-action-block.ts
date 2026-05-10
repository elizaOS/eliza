/**
 * Local stub for CoordinationLLMResponse — removed from
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

import { isPermissionId, type PermissionId } from "@elizaos/shared";

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
 * Strip JSON action blocks from text before displaying in chat.
 * Handles both fenced (```json ... ```) and bare JSON formats.
 */
export function stripActionBlockFromDisplay(text: string): string {
  const safeText = text.length > 100_000 ? text.slice(0, 100_000) : text;
  // First: fenced ```json action blocks — only strip if the action value is
  // one of our known orchestrator actions to avoid false-positive stripping.
  let cleaned = safeText.replace(
    /```(?:json)?\s{0,32}\n?(\{[\s\S]{0,50000}?"action"[\s\S]{0,50000}?\})\s{0,32}\n?```/g,
    (_match, json: string) => {
      try {
        const parsed = JSON.parse(json);
        if (isValidActionEnvelope(parsed)) return "";
      } catch {
        // malformed JSON — leave as-is
      }
      return _match;
    },
  );

  // Second: bare JSON action blocks. Walk backwards from end of string to find
  // the last '{' that starts a valid JSON object containing an "action" key.
  // Note: this won't match nested objects (e.g. {"action":"respond","ctx":{"k":"v"}})
  // because JSON.parse would fail on the truncated slice. Safe given our flat action schema.
  const lastBrace = cleaned.lastIndexOf("{");
  if (lastBrace >= 0) {
    const candidate = cleaned.slice(lastBrace);
    try {
      const parsed = JSON.parse(candidate);
      if (isValidActionEnvelope(parsed)) {
        cleaned = cleaned.slice(0, lastBrace);
      }
    } catch {
      // Not valid JSON — leave text as-is
    }
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
  const safeText = text.length > 100_000 ? text.slice(0, 100_000) : text;
  // Try fenced ```json block first
  const fenced = safeText.match(
    /```(?:json)?\s{0,32}\n?(\{[\s\S]{0,50000}?\})\s{0,32}\n?```/,
  );
  // Bare JSON fallback: non-greedy match from first { containing "action" to next }
  const jsonStr =
    fenced?.[1] ??
    safeText.match(/\{[^}]{0,50000}"action"[^}]{0,50000}\}/)?.[0];
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!isValidActionEnvelope(parsed)) return null;
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
  } catch {
    return null;
  }
}
