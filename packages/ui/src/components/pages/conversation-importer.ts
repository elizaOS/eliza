export type ConversationImportSource =
  | "chatgpt"
  | "claude"
  | "hermes"
  | "openclaw";

export interface ConversationImportTurn {
  conversationTitle: string;
  speaker: string;
  text: string;
  createdAt?: number;
}

export interface ConversationImportPreview {
  source: ConversationImportSource;
  turns: ConversationImportTurn[];
  redactedTurns: ConversationImportTurn[];
  counts: {
    conversations: number;
    turns: number;
    redactions: number;
  };
  examples: ConversationImportTurn[];
  warnings: string[];
}

const MAX_TURNS = 500;
const SECRET_PATTERNS = [
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;"']{4,})/gi,
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
] as const;

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(coerceText).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.parts))
      return record.parts.map(coerceText).join("\n");
  }
  return "";
}

function coerceSpeaker(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.role === "string") return record.role;
    if (typeof record.name === "string") return record.name;
  }
  return "unknown";
}

function coerceTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function redactConversationImportText(text: string): {
  text: string;
  redactions: number;
} {
  let redactions = 0;
  let next = text;
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, (...args) => {
      redactions += 1;
      const match = String(args[0]);
      if (/^(api[_-]?key|token|password|secret)/i.test(match)) {
        return match.replace(/[:=]\s*.*/u, ": [REDACTED]");
      }
      return "[REDACTED]";
    });
  }
  return { text: next, redactions };
}

function pushTurn(
  turns: ConversationImportTurn[],
  title: string,
  speaker: unknown,
  text: unknown,
  createdAt?: unknown,
) {
  const cleanText = coerceText(text).trim();
  if (!cleanText) return;
  turns.push({
    conversationTitle: title.trim() || "Untitled conversation",
    speaker: coerceSpeaker(speaker),
    text: cleanText,
    createdAt: coerceTimestamp(createdAt),
  });
}

function parseChatGptExport(root: unknown): ConversationImportTurn[] {
  const conversations = Array.isArray(root)
    ? root
    : Array.isArray((root as Record<string, unknown>)?.conversations)
      ? ((root as Record<string, unknown>).conversations as unknown[])
      : [];
  const turns: ConversationImportTurn[] = [];

  for (const conversation of conversations) {
    if (!conversation || typeof conversation !== "object") continue;
    const record = conversation as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : "ChatGPT";
    const mapping = record.mapping;
    if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      const nodes = Object.values(mapping as Record<string, unknown>);
      for (const node of nodes) {
        const message = (node as Record<string, unknown> | undefined)?.message;
        if (!message || typeof message !== "object") continue;
        const msg = message as Record<string, unknown>;
        const content = msg.content as Record<string, unknown> | undefined;
        pushTurn(turns, title, msg.author, content, msg.create_time);
      }
      continue;
    }
    const messages = Array.isArray(record.messages) ? record.messages : [];
    for (const message of messages) {
      const msg = message as Record<string, unknown>;
      pushTurn(
        turns,
        title,
        msg.author ?? msg.role,
        msg.content ?? msg.text,
        msg.create_time,
      );
    }
  }
  return turns;
}

function parseConversationList(
  root: unknown,
  fallbackTitle: string,
): ConversationImportTurn[] {
  const conversations = Array.isArray(root)
    ? root
    : Array.isArray((root as Record<string, unknown>)?.conversations)
      ? ((root as Record<string, unknown>).conversations as unknown[])
      : Array.isArray((root as Record<string, unknown>)?.sessions)
        ? ((root as Record<string, unknown>).sessions as unknown[])
        : [root];
  const turns: ConversationImportTurn[] = [];

  for (const conversation of conversations) {
    if (!conversation || typeof conversation !== "object") continue;
    const record = conversation as Record<string, unknown>;
    const title =
      typeof record.title === "string"
        ? record.title
        : typeof record.name === "string"
          ? record.name
          : fallbackTitle;
    const messages = Array.isArray(record.chat_messages)
      ? record.chat_messages
      : Array.isArray(record.messages)
        ? record.messages
        : Array.isArray(record.turns)
          ? record.turns
          : [];
    for (const message of messages) {
      const msg = message as Record<string, unknown>;
      pushTurn(
        turns,
        title,
        msg.sender ?? msg.role ?? msg.author,
        msg.text ?? msg.content ?? msg.message,
        msg.created_at ?? msg.timestamp ?? msg.time,
      );
    }
  }
  return turns;
}

function parsePlainTextImport(rawText: string): ConversationImportTurn[] {
  return rawText
    .split(/\n{2,}/u)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({
      conversationTitle: "Plain text import",
      speaker: index % 2 === 0 ? "user" : "assistant",
      text,
    }));
}

export function parseConversationImport(
  source: ConversationImportSource,
  rawText: string,
): ConversationImportPreview {
  const warnings: string[] = [];
  let parsed: unknown;
  let plainTextTurns: ConversationImportTurn[] | null = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    plainTextTurns = parsePlainTextImport(rawText);
    parsed = null;
    warnings.push("Parsed as plain text because the file was not valid JSON.");
  }

  const turns =
    plainTextTurns ??
    (source === "chatgpt"
      ? parseChatGptExport(parsed)
      : parseConversationList(parsed, source));
  const boundedTurns = turns.slice(0, MAX_TURNS);
  if (turns.length > MAX_TURNS) {
    warnings.push(`Preview limited to the first ${MAX_TURNS} non-empty turns.`);
  }

  let redactions = 0;
  const redactedTurns = boundedTurns.map((turn) => {
    const result = redactConversationImportText(turn.text);
    redactions += result.redactions;
    return { ...turn, text: result.text };
  });
  const conversationCount = new Set(
    boundedTurns.map((turn) => turn.conversationTitle),
  ).size;

  return {
    source,
    turns: boundedTurns,
    redactedTurns,
    counts: {
      conversations: conversationCount,
      turns: boundedTurns.length,
      redactions,
    },
    examples: redactedTurns.slice(0, 3),
    warnings,
  };
}

export function formatImportedConversationMemory(
  source: ConversationImportSource,
  turn: ConversationImportTurn,
  batchId: string,
): string {
  const date = turn.createdAt
    ? new Date(turn.createdAt).toISOString()
    : "unknown time";
  return [
    `[conversation-import:${batchId}]`,
    `Source: ${source}`,
    `Conversation: ${turn.conversationTitle}`,
    `Speaker: ${turn.speaker}`,
    `Timestamp: ${date}`,
    "",
    turn.text,
  ].join("\n");
}
