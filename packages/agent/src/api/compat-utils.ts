function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Extract a best-effort text string from OpenAI/Anthropic "content" fields.
 * Supports:
 * - string
 * - array of parts: [{ type: "text", text: "..." }, ...]
 * - objects with a `text` string field
 */
export function extractCompatTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      const obj = asRecord(item);
      if (!obj) continue;
      const type = readString(obj.type);
      if (type && type !== "text") continue;
      const text = readString(obj.text);
      if (text) chunks.push(text);
    }
    return chunks.join("");
  }
  const obj = asRecord(content);
  if (obj) return readString(obj.text);
  return "";
}

export type OpenAiChatRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool"
  | "function";

export interface OpenAiChatMessage {
  role: OpenAiChatRole;
  content?: unknown;
}

/**
 * For OpenAI-compatible requests, we intentionally reduce "messages" to:
 * - all system/developer messages (joined)
 * - the last user message
 *
 * This keeps the server-side room memory coherent (so stateless clients that
 * resend full history do not cause runaway duplication).
 */
export function extractOpenAiSystemAndLastUser(
  messages: unknown,
): { system: string; user: string } | null {
  if (!Array.isArray(messages)) return null;

  let system = "";
  let user = "";

  for (const item of messages) {
    const msg = asRecord(item);
    if (!msg) continue;
    const role = readString(msg.role) as OpenAiChatRole;
    const contentText = extractCompatTextContent(msg.content);
    if (!contentText.trim()) continue;

    if (role === "system" || role === "developer") {
      system = system
        ? `${system}\n\n${contentText.trim()}`
        : contentText.trim();
      continue;
    }
    if (role === "user") {
      user = contentText.trim();
    }
  }

  if (!user) return null;
  return { system, user };
}

export type AnthropicRole = "user" | "assistant";

export interface AnthropicMessage {
  role: AnthropicRole;
  content?: unknown;
}

export function extractAnthropicSystemAndLastUser(args: {
  system?: unknown;
  messages: unknown;
}): { system: string; user: string } | null {
  if (!Array.isArray(args.messages)) return null;

  const system = readString(args.system).trim();
  let user = "";

  for (const item of args.messages) {
    const msg = asRecord(item);
    if (!msg) continue;
    const role = readString(msg.role) as AnthropicRole;
    if (role !== "user") continue;
    const contentText = extractCompatTextContent(msg.content);
    if (!contentText.trim()) continue;
    user = contentText.trim();
  }

  if (!user) return null;
  return { system, user };
}

function readNestedString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const raw = obj[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return null;
}

/**
 * Resolve a stable room key for compatibility endpoints so manual testing can
 * keep conversation memory when the client provides an identifier.
 *
 * We accept a few common fields without requiring any one client:
 * - OpenAI: body.user (string)
 * - OpenAI: body.metadata.conversation_id
 * - Anthropic: body.metadata.user_id
 * - Anthropic: body.metadata.conversation_id
 */
export function resolveCompatRoomKey(
  body: Record<string, unknown>,
  fallback = "default",
): string {
  const direct = readNestedString(body, "user");
  if (direct) return direct;

  const metadata = asRecord(body.metadata);
  if (metadata) {
    const conv =
      readNestedString(metadata, "conversation_id") ??
      readNestedString(metadata, "conversationId");
    if (conv) return conv;
    const userId = readNestedString(metadata, "user_id");
    if (userId) return userId;
  }

  return fallback;
}
