import type {
  AgentStartupDiagnostics,
  AgentStatus,
  ConversationMessage,
  CustomActionDef,
  StreamEventEnvelope,
} from "../api/client";
import {
  computeStreamingDelta as computeStreamingDeltaInternal,
  mergeStreamingText,
} from "../utils/streaming-text";
import {
  AGENT_STATES,
  type ApiLikeError,
  type SlashCommandInput,
} from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseAgentStatusEvent(
  data: Record<string, unknown>,
): AgentStatus | null {
  const state = data.state;
  const agentName = data.agentName;
  if (
    typeof state !== "string" ||
    !AGENT_STATES.has(state as AgentStatus["state"])
  ) {
    return null;
  }
  if (typeof agentName !== "string") return null;
  const model = typeof data.model === "string" ? data.model : undefined;
  const startedAt =
    typeof data.startedAt === "number" ? data.startedAt : undefined;
  const uptime = typeof data.uptime === "number" ? data.uptime : undefined;
  const startup = parseAgentStartupDiagnostics(data.startup);
  return {
    state: state as AgentStatus["state"],
    agentName,
    model,
    startedAt,
    uptime,
    startup,
  };
}

/**
 * Parses `agentStatus` from a `desktopTrayMenuClick` payload when the main
 * process finishes menu reset (`itemId === "menu-reset-app-applied"`).
 */
export function parseAgentStatusFromMainMenuResetPayload(
  payload: unknown,
): AgentStatus | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("agentStatus" in payload)
  ) {
    return null;
  }
  const as = (payload as { agentStatus?: Record<string, unknown> | null })
    .agentStatus;
  if (!as || typeof as !== "object" || Array.isArray(as)) {
    return null;
  }
  return parseAgentStatusEvent(as);
}

export function parseAgentStartupDiagnostics(
  value: unknown,
): AgentStartupDiagnostics | undefined {
  if (!isRecord(value)) return undefined;
  const phase = value.phase;
  const attempt = value.attempt;
  if (typeof phase !== "string" || typeof attempt !== "number") {
    return undefined;
  }
  const startup: AgentStartupDiagnostics = { phase, attempt };
  if (typeof value.lastError === "string") startup.lastError = value.lastError;
  if (typeof value.lastErrorAt === "number")
    startup.lastErrorAt = value.lastErrorAt;
  if (typeof value.nextRetryAt === "number")
    startup.nextRetryAt = value.nextRetryAt;
  const embPhase = value.embeddingPhase;
  if (
    embPhase === "checking" ||
    embPhase === "downloading" ||
    embPhase === "loading" ||
    embPhase === "ready"
  ) {
    startup.embeddingPhase = embPhase;
  }
  if (typeof value.embeddingDetail === "string") {
    startup.embeddingDetail = value.embeddingDetail;
  }
  const embPct = value.embeddingProgressPct;
  if (typeof embPct === "number" && Number.isFinite(embPct)) {
    startup.embeddingProgressPct = Math.max(0, Math.min(100, embPct));
  }
  return startup;
}

export function parseStreamEventEnvelopeEvent(
  data: Record<string, unknown>,
): StreamEventEnvelope | null {
  const type = data.type;
  const eventId = data.eventId;
  const ts = data.ts;
  const payload = data.payload;
  if (
    (type !== "agent_event" &&
      type !== "heartbeat_event" &&
      type !== "training_event") ||
    typeof eventId !== "string" ||
    typeof ts !== "number" ||
    !isRecord(payload)
  ) {
    return null;
  }

  const envelope: StreamEventEnvelope = {
    type,
    version: 1,
    eventId,
    ts,
    payload,
  };
  if (typeof data.runId === "string") envelope.runId = data.runId;
  if (typeof data.seq === "number") envelope.seq = data.seq;
  if (typeof data.stream === "string") envelope.stream = data.stream;
  if (typeof data.sessionKey === "string")
    envelope.sessionKey = data.sessionKey;
  if (typeof data.agentId === "string") envelope.agentId = data.agentId;
  if (typeof data.roomId === "string") envelope.roomId = data.roomId;
  return envelope;
}

export function parseConversationMessageEvent(
  value: unknown,
): ConversationMessage | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const role = value.role;
  const text = value.text;
  const timestamp = value.timestamp;
  const source = value.source;
  const actionName = value.actionName;
  const actionCallbackHistory = value.actionCallbackHistory;
  const from = value.from;
  const fromUserName = value.fromUserName;
  const avatarUrl = value.avatarUrl;
  const replyToMessageId = value.replyToMessageId;
  const replyToSenderName = value.replyToSenderName;
  const replyToSenderUserName = value.replyToSenderUserName;
  const reactions = value.reactions;
  if (
    typeof id !== "string" ||
    (role !== "user" && role !== "assistant") ||
    typeof text !== "string" ||
    typeof timestamp !== "number"
  ) {
    return null;
  }
  const parsed: ConversationMessage = { id, role, text, timestamp };
  if (typeof source === "string" && source.length > 0) {
    parsed.source = source;
  }
  if (typeof actionName === "string" && actionName.length > 0) {
    parsed.actionName = actionName;
  }
  if (Array.isArray(actionCallbackHistory)) {
    const normalized = actionCallbackHistory.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
    if (normalized.length > 0) {
      parsed.actionCallbackHistory = normalized;
    }
  }
  if (typeof from === "string" && from.length > 0) {
    parsed.from = from;
  }
  if (typeof fromUserName === "string" && fromUserName.length > 0) {
    parsed.fromUserName = fromUserName;
  }
  if (typeof avatarUrl === "string" && avatarUrl.length > 0) {
    parsed.avatarUrl = avatarUrl;
  }
  if (typeof replyToMessageId === "string" && replyToMessageId.length > 0) {
    parsed.replyToMessageId = replyToMessageId;
  }
  if (typeof replyToSenderName === "string" && replyToSenderName.length > 0) {
    parsed.replyToSenderName = replyToSenderName;
  }
  if (
    typeof replyToSenderUserName === "string" &&
    replyToSenderUserName.length > 0
  ) {
    parsed.replyToSenderUserName = replyToSenderUserName;
  }
  if (Array.isArray(reactions)) {
    const parsedReactions = reactions
      .map((reaction) => {
        if (!isRecord(reaction)) return null;
        const emoji = reaction.emoji;
        const count = reaction.count;
        const users = reaction.users;
        if (
          typeof emoji !== "string" ||
          emoji.length === 0 ||
          typeof count !== "number" ||
          !Number.isFinite(count) ||
          count <= 0
        ) {
          return null;
        }
        const parsedReaction: {
          emoji: string;
          count: number;
          users?: string[];
        } = {
          emoji,
          count,
        };
        if (Array.isArray(users)) {
          const parsedUsers = users.filter(
            (user): user is string =>
              typeof user === "string" && user.length > 0,
          );
          if (parsedUsers.length > 0) {
            parsedReaction.users = parsedUsers;
          }
        }
        return parsedReaction;
      })
      .filter(
        (
          reaction,
        ): reaction is {
          emoji: string;
          count: number;
          users?: string[];
        } => reaction !== null,
      );
    if (parsedReactions.length > 0) {
      parsed.reactions = parsedReactions;
    }
  }
  return parsed;
}

export function parseProactiveMessageEvent(
  data: Record<string, unknown>,
): { conversationId: string; message: ConversationMessage } | null {
  const conversationId = data.conversationId;
  if (typeof conversationId !== "string") return null;
  const message = parseConversationMessageEvent(data.message);
  if (!message) return null;
  return { conversationId, message };
}

export { mergeStreamingText };

export function computeStreamingDelta(
  existing: string,
  incoming: string,
): string {
  return computeStreamingDeltaInternal(existing, incoming);
}

export function normalizeStreamComparisonText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function shouldApplyFinalStreamText(
  streamed: string,
  finalText: string,
): boolean {
  if (!finalText.trim()) return false;
  if (!streamed) return true;
  if (streamed === finalText) return false;
  return (
    normalizeStreamComparisonText(streamed) !==
    normalizeStreamComparisonText(finalText)
  );
}

// Function previously local to chat-commands but used here
function normalizeSlashCommandName(name: string): string {
  if (!name.startsWith("/")) name = `/${name}`;
  return name.trim().toLowerCase();
}

// A simple utility to split command arguments, equivalent to chat-commands splitCommandArgs
function splitCommandArgs(text: string): string[] {
  const parts: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    parts.push(match[1] || match[2] || match[0]);
    match = regex.exec(text);
  }
  return parts;
}

export function parseSlashCommandInput(text: string): SlashCommandInput | null {
  if (!text.startsWith("/")) return null;
  const body = text.slice(1).trim();
  if (!body) return null;
  const firstSpace = body.search(/\s/);
  if (firstSpace === -1) {
    return { name: normalizeSlashCommandName(body), argsRaw: "" };
  }
  return {
    name: normalizeSlashCommandName(body.slice(0, firstSpace)),
    argsRaw: body.slice(firstSpace + 1).trim(),
  };
}

export function normalizeCustomActionName(value: string): string {
  return value
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

export function parseCustomActionParams(
  action: CustomActionDef,
  argsRaw: string,
): {
  params: Record<string, string>;
  missingRequired: string[];
} {
  const tokens = splitCommandArgs(argsRaw);
  const named = new Map<string, string>();
  const positional: string[] = [];

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq).trim().toLowerCase();
      const value = token.slice(eq + 1).trim();
      if (key) {
        named.set(key, value);
        continue;
      }
    }
    positional.push(token);
  }

  const params: Record<string, string> = {};
  const defs = Array.isArray(action.parameters) ? action.parameters : [];
  const defsByLower = new Map(
    defs.map((def) => [def.name.trim().toLowerCase(), def.name]),
  );

  for (const [key, value] of named) {
    const canonical = defsByLower.get(key);
    if (canonical) {
      params[canonical] = value;
    } else {
      params[key] = value;
    }
  }

  for (const def of defs) {
    if (params[def.name] == null && positional.length > 0) {
      params[def.name] = positional.shift() as string;
    }
  }

  if (positional.length > 0) {
    const sink = defs.find((def) =>
      ["input", "text", "query", "message", "prompt"].includes(
        def.name.toLowerCase(),
      ),
    );
    if (sink) {
      const existing = params[sink.name];
      params[sink.name] = existing
        ? `${existing} ${positional.join(" ")}`
        : positional.join(" ");
    }
  }

  const missingRequired = defs
    .filter((def) => def.required)
    .map((def) => def.name)
    .filter((name) => !(params[name] ?? "").trim());

  return { params, missingRequired };
}

/** Plain-text variant of formatSearchBullet (uses `- ` bullets, no bold). */
export function formatSearchBullet(label: string, items: string[]): string {
  if (items.length === 0) return `${label}: none`;
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function asApiLikeError(err: unknown): ApiLikeError | null {
  if (!isRecord(err)) return null;
  const kind = err.kind;
  const status = err.status;
  const path = err.path;
  const message = err.message;
  const hasApiShape =
    typeof kind === "string" ||
    typeof status === "number" ||
    typeof path === "string";
  if (!hasApiShape) return null;
  return {
    kind: typeof kind === "string" ? kind : undefined,
    status: typeof status === "number" ? status : undefined,
    path: typeof path === "string" ? path : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

/** API-error-aware variant that extracts path/status/message from structured errors. */
export function formatStartupErrorDetail(err: unknown): string | undefined {
  const apiErr = asApiLikeError(err);
  if (apiErr) {
    const parts: string[] = [];
    if (apiErr.path) parts.push(apiErr.path);
    if (typeof apiErr.status === "number") parts.push(`HTTP ${apiErr.status}`);
    if (apiErr.message) parts.push(apiErr.message);
    return parts.filter(Boolean).join(" - ");
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  return undefined;
}
