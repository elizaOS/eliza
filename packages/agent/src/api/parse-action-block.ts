/**
 * Local stub for CoordinationLLMResponse — removed from
 * @elizaos/plugin-agent-orchestrator 2.x.  Matches the shape this file needs.
 */
interface CoordinationLLMResponse {
  action: string;
  reasoning: string;
  response?: string;
  useKeys?: boolean;
  keys?: string[];
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

const VALID_ACTIONS = ["respond", "escalate", "ignore", "complete"];
const ACTION_KEYS = new Set([
  "action",
  "reasoning",
  "response",
  "useKeys",
  "keys",
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
    const hasResponse =
      typeof record.response === "string" && record.response.length > 0;
    const hasKeys =
      record.useKeys === true &&
      Array.isArray(record.keys) &&
      record.keys.length > 0;
    return hasResponse || hasKeys;
  }

  // Non-respond actions should not carry respond-only fields.
  if ("response" in record || "useKeys" in record || "keys" in record) {
    return false;
  }
  return true;
}

/**
 * Strip JSON action blocks from text before displaying in chat.
 * Handles both fenced (```json ... ```) and bare JSON formats.
 */
export function stripActionBlockFromDisplay(text: string): string {
  // First: fenced ```json action blocks — only strip if the action value is
  // one of our known orchestrator actions to avoid false-positive stripping.
  let cleaned = text.replace(
    /```(?:json)?\s*\n?(\{[\s\S]*?"action"[\s\S]*?\})\s*\n?```/g,
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
  // Try fenced ```json block first
  const fenced = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/);
  // Bare JSON fallback: non-greedy match from first { containing "action" to next }
  const jsonStr = fenced?.[1] ?? text.match(/\{[^}]*"action"[^}]*\}/)?.[0];
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
    return result;
  } catch {
    return null;
  }
}
