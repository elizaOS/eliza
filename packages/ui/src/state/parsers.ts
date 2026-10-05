/**
 * Pure parsers that turn untrusted stream/WS payloads into the typed shapes the
 * chat reducer consumes (agent status, startup diagnostics, conversation
 * messages and custom-action params). No React, no I/O.
 */

import { parseChatFailureKind } from "@elizaos/contracts";
import type { ConversationMessage } from "../api/client-types-chat";
import type {
  AgentModelReadiness,
  AgentStartupDiagnostics,
  AgentStatus,
  LocalModelReadiness,
  StreamEventEnvelope,
} from "../api/client-types-core";
import {
  computeStreamingDelta as computeStreamingDeltaInternal,
  mergeStreamingText,
} from "../utils/streaming-text.js";
import { AGENT_STATES, type ApiLikeError } from "./types";
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
/**
 * Validates the server's Cloud model readiness projection. Unrecognized or
 * malformed shapes are dropped rather than coerced.
 */
export function parseAgentModelReadiness(
  value: unknown,
): AgentModelReadiness | undefined {
  if (!isRecord(value)) return undefined;
  const checkedAt = value.checkedAt;
  if (value.status === "available" && typeof checkedAt === "number") {
    return { status: "available", checkedAt };
  }
  if (
    value.status === "unknown" &&
    typeof value.reason === "string" &&
    (checkedAt === null || typeof checkedAt === "number")
  ) {
    return { status: "unknown", reason: value.reason, checkedAt };
  }
  if (
    value.status === "model_not_available" &&
    value.code === "MODEL_NOT_AVAILABLE" &&
    typeof value.message === "string" &&
    typeof checkedAt === "number" &&
    Array.isArray(value.missing)
  ) {
    const missing: Extract<
      AgentModelReadiness,
      { status: "model_not_available" }
    >["missing"] = [];
    for (const entry of value.missing) {
      if (
        !isRecord(entry) ||
        (entry.modelType !== "TEXT_SMALL" &&
          entry.modelType !== "TEXT_LARGE") ||
        typeof entry.modelId !== "string" ||
        (entry.configKey !== null && typeof entry.configKey !== "string")
      ) {
        return undefined;
      }
      missing.push({
        modelType: entry.modelType,
        configKey: entry.configKey,
        modelId: entry.modelId,
      });
    }
    return {
      status: "model_not_available",
      code: "MODEL_NOT_AVAILABLE",
      missing,
      message: value.message,
      checkedAt,
    };
  }
  return undefined;
}
/** Accept only the host's runtime-owned, sole-local-provider readiness shape. */
export function parseLocalModelReadiness(
  value: unknown,
): LocalModelReadiness | undefined {
  if (!isRecord(value) || value.provider !== "eliza-local-inference")
    return undefined;
  if (value.status !== "available" && value.status !== "model_not_loaded")
    return undefined;
  return { provider: "eliza-local-inference", status: value.status };
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
  // `canRespond` is the server-authoritative readiness signal (deriveAgentReady).
  // Carry it through from the WS `status` event — dropping it would reset a ready
  // agent's status to `canRespond: undefined`, which falls back to running+model
  // and (for a cloud agent with no locally-detected model) wrongly re-gates the
  // composer back to "waking up".
  const canRespond =
    typeof data.canRespond === "boolean" ? data.canRespond : undefined;
  const modelReadiness = parseAgentModelReadiness(data.modelReadiness);
  const localModelReadiness = parseLocalModelReadiness(
    data.localModelReadiness,
  );
  return {
    state: state as AgentStatus["state"],
    agentName,
    model,
    ...(canRespond !== undefined ? { canRespond } : {}),
    ...(modelReadiness ? { modelReadiness } : {}),
    ...(localModelReadiness ? { localModelReadiness } : {}),
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
  const as = (
    payload as {
      agentStatus?: Record<string, unknown> | null;
    }
  ).agentStatus;
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
    (type !== "agent_event" && type !== "heartbeat_event") ||
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
  const transcriptVisibility = value.transcriptVisibility;
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
  const failureKind = parseChatFailureKind(value.failureKind);
  if (role === "assistant" && failureKind) parsed.failureKind = failureKind;
  if (
    role === "assistant" &&
    typeof value.planningAcknowledgment === "string" &&
    value.planningAcknowledgment.trim()
  ) {
    parsed.planningAcknowledgment = value.planningAcknowledgment;
  }
  if (transcriptVisibility === "internal") {
    parsed.transcriptVisibility = transcriptVisibility;
  }
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
export function parseProactiveMessageEvent(data: Record<string, unknown>): {
  conversationId: string;
  message: ConversationMessage;
} | null {
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
// Split command arguments into tokens. Each token is an optional `key=` prefix
// followed by a value that is either a quoted string (quotes stripped, inner
// spaces preserved) or a bare run of non-space chars. Keeping `key="multi word"`
// and `key='multi word'` as a single `key=multi word` token lets a named arg

/** Plain-text variant of formatSearchBullet (uses `- ` bullets, no bold). */
export function formatSearchBullet(label: string, items: string[]): string {
  if (items.length === 0) return `${label}: none`;
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}
export function asApiLikeError(err: unknown): ApiLikeError | null {
  if (!isRecord(err)) return null;
  const kind = err.kind;
  const code = err.code;
  const status = err.status;
  const path = err.path;
  const message = err.message;
  const data = err.data;
  const hasApiShape =
    typeof kind === "string" ||
    typeof status === "number" ||
    typeof path === "string";
  if (!hasApiShape) return null;
  return {
    kind: typeof kind === "string" ? kind : undefined,
    code: typeof code === "string" ? code : undefined,
    status: typeof status === "number" ? status : undefined,
    path: typeof path === "string" ? path : undefined,
    message: typeof message === "string" ? message : undefined,
    data,
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
