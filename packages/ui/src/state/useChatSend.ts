/**
 * Chat send callbacks — message sending and streaming operations.
 *
 * Extracted from useChatCallbacks.ts. Handles all message sending,
 * streaming, stop, retry, edit, clear, and queue management.
 */

import { asRecord } from "@elizaos/shared";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type { Conversation, CustomActionDef } from "../api";
import {
  type ChatTurnStatus,
  type CodingAgentSession,
  type ConversationChannelType,
  type ConversationMessage,
  client,
  type ImageAttachment,
  type MessageAttachmentContentType,
} from "../api";
import { isLimitedCloudAgentApiBase } from "../api/app-shell-capabilities";
import { isStreamGenerationError } from "../api/client-base";
import {
  expandSavedCustomCommand,
  loadSavedCustomCommands,
  normalizeSlashCommandName,
} from "../chat";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
} from "../events";
import { getWindowNavigationPath, type Tab } from "../navigation";
import { clearChatDraft } from "./ChatComposerContext.hooks";
import { isConversationRecord } from "./chat-conversation-guards";
import {
  applyStreamingTextModification,
  formatSearchBullet,
  type LoadConversationMessagesResult,
  mergeStreamingText,
  normalizeCustomActionName,
  parseCustomActionParams,
  parseSlashCommandInput,
  shouldApplyFinalStreamText,
} from "./internal";

// ── Types ────────────────────────────────────────────────────────────

const CONTEXT_ROUTING_METADATA_KEY = "__responseContext";

/** Derive the rendered-attachment kind for an optimistic bubble from its MIME. */
function optimisticAttachmentKind(
  mimeType: string,
): MessageAttachmentContentType {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("text/") || mimeType === "application/pdf") {
    return "document";
  }
  return "image";
}

/**
 * True when the active client base is an Eliza Cloud agent — either the
 * shared-runtime REST adapter (`/api/v1/eliza/agents/<id>`) or a dedicated agent
 * on its own `<id>.elizacloud.ai` subdomain. A chat-send 404 against such a base
 * is ambiguous: it can mean "the conversation was deleted" (recoverable by
 * recreating the conversation) OR "the agent itself was deleted / is
 * unreachable" — in which case recreating the conversation also 404s and the
 * user's message must NOT be silently dropped.
 */
function isCloudAgentBase(value: string | null | undefined): boolean {
  return isLimitedCloudAgentApiBase(value);
}

interface ChatViewRouting {
  view: string;
  primaryContext: string;
  secondaryContexts: string[];
  capabilities: string[];
}

interface ActiveChatTurn {
  controller: AbortController;
  roomId: string | null;
  abortServerTurn: (() => void) | null;
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value.split(/[\n,;]/);
  }
  return [];
}

/**
 * 4xx statuses whose response body carries a user-actionable validation reason
 * (bad/oversized/unsupported payload) rather than an infrastructure condition.
 * Auth (401/403), rate limit (429), and not-found (404) have their own
 * handling and are deliberately excluded.
 */
const VALIDATION_FAILURE_STATUSES: ReadonlySet<number> = new Set([
  400, 413, 415, 422,
]);

/**
 * Extract the server's validation reason from a send failure, or `null` when
 * the failure isn't a payload-validation 4xx. The client's ApiError carries
 * the server's JSON `error` body as its message (e.g. "Attachment too large
 * (max 5 MB)"), which tells the user exactly what to fix — the generic "didn't
 * go through, please resend" copy would send them into a retry loop that fails
 * identically every time. Exported for the send path and unit tests.
 */
export function getSendValidationFailureMessage(err: unknown): string | null {
  const status = (err as { status?: number }).status;
  if (typeof status !== "number" || !VALIDATION_FAILURE_STATUSES.has(status)) {
    return null;
  }
  const message = err instanceof Error ? err.message.trim() : "";
  // A body-less rejection falls back to "HTTP <status>" upstream — that is not
  // a validation reason worth surfacing over the generic copy.
  if (!message || /^HTTP \d+$/i.test(message)) return null;
  return message;
}

/**
 * Map a send/stream failure (HTTP status + error `kind`) to a user-facing notice
 * so a stalled turn is never silent dead air. Shared by the main-chat send path
 * and the action/inbox/connector send path — both must surface the same
 * status-specific message. (#10231) 4xx validation rejections surface the
 * server's specific reason; 5xx/network/timeout keep the generic copy (their
 * bodies are internal noise, and resending genuinely can succeed).
 */
export function buildSendFailureNotice(err: unknown): string {
  const status = (err as { status?: number }).status;
  const kind = (err as { kind?: string }).kind;
  if (status === 401 || status === 403) {
    return "Your session expired — sign in again and resend your message.";
  }
  if (status === 429) {
    return "The agent is busy right now — wait a few seconds and resend.";
  }
  if (status === 503 || status === 502) {
    return "The agent is still waking up — give it a moment and resend.";
  }
  const validationMessage = getSendValidationFailureMessage(err);
  if (validationMessage !== null) {
    return `The agent couldn't accept that message: ${validationMessage}.`;
  }
  if (kind === "timeout") {
    return "The agent took too long to respond — give it a moment and resend.";
  }
  if (kind === "network") {
    return "Couldn't reach the agent — check your connection and resend.";
  }
  return "That message didn't go through — please resend.";
}

/**
 * Assistant-bubble copy for a user turn the server never accepted — e.g. sent
 * while the local model was still warming up and the runtime-ready hold
 * expired (503), or the runtime produced nothing and persisted nothing.
 * Stamped with a retryable `provider_issue` failureKind so the thread shows a
 * Retry chip instead of silently evicting the message (#11670).
 */
export const UNDELIVERED_TURN_NOTICE =
  "That message didn't reach the agent — it may still be starting up. Retry in a moment.";

/**
 * Clock-skew slack for matching a just-sent user turn against the server's
 * reloaded history. The persisted turn's server timestamp lands at-or-after
 * the client's send time on the same clock; the slack tolerates a cloud
 * server clock trailing the device's.
 */
const SENT_TURN_MATCH_SLACK_MS = 60_000;

/**
 * Whether the just-sent user turn survived the post-turn history reload —
 * i.e. the server persisted it and the reload carries it (or the reload never
 * replaced local state, leaving the optimistic bubble in place). Matches by
 * text among user turns no older than the send minus clock-skew slack, so an
 * identical message from an earlier exchange can't mask an eviction.
 */
function sentUserTurnPresent(
  messages: readonly ConversationMessage[],
  sentText: string,
  sentAt: number,
): boolean {
  const text = sentText.trim();
  return messages.some(
    (message) =>
      message.role === "user" &&
      message.timestamp >= sentAt - SENT_TURN_MATCH_SLACK_MS &&
      message.text.trim() === text,
  );
}

function abortServerConversationTurn(
  roomId: string | null | undefined,
  reason: string,
): void {
  if (!roomId) return;
  void client.abortConversationTurn(roomId, reason).catch(() => {});
}

function normalizeViewPath(path: string | null | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) return "/";
  const withoutQuery = trimmed.split("?")[0]?.split("#")[0] ?? "/";
  const normalized = withoutQuery.startsWith("/")
    ? withoutQuery
    : `/${withoutQuery}`;
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

function dynamicViewNameFromPath(path: string): string {
  const slug = normalizeViewPath(path).split("/").filter(Boolean)[0];
  return slug || "views";
}

function resolveChatViewRouting(
  tab: Tab,
  navigationPath: string,
): ChatViewRouting {
  const viewPath = normalizeViewPath(navigationPath).toLowerCase();
  if (viewPath === "/orchestrator" || viewPath.startsWith("/orchestrator/")) {
    return {
      view: "orchestrator",
      primaryContext: "code",
      secondaryContexts: ["admin", "documents"],
      capabilities: [
        "orchestrator-task",
        "coding-agent",
        "task-history",
        "workspace-control",
      ],
    };
  }

  switch (tab) {
    case "apps":
      return {
        view: "apps",
        primaryContext: "apps",
        secondaryContexts: ["admin"],
        capabilities: ["launch-app", "stop-app"],
      };
    case "character":
    case "character-select":
      return {
        view: "character",
        primaryContext: "character",
        secondaryContexts: ["documents", "admin"],
        capabilities: ["modify-character", "edit-character-documents"],
      };
    case "documents":
      return {
        view: "character",
        primaryContext: "documents",
        secondaryContexts: ["character"],
        capabilities: ["search-documents", "add-documents", "modify-character"],
      };
    case "automations":
    case "triggers":
      return {
        view: "automations",
        primaryContext: "automation",
        secondaryContexts: ["code", "admin"],
        capabilities: ["manage-cron", "manage-workflow", "run-automation"],
      };
    case "browser":
      return {
        view: "browser",
        primaryContext: "browser",
        secondaryContexts: ["documents"],
        capabilities: ["browser-session", "browse", "extract-page"],
      };
    case "inventory":
      return {
        view: "wallet",
        primaryContext: "wallet",
        secondaryContexts: ["documents"],
        capabilities: ["wallet", "portfolio", "transactions"],
      };
    case "plugins":
    case "runtime":
    case "database":
    case "logs":
    case "settings":
    case "voice":
      return {
        view: "system",
        primaryContext: "system",
        secondaryContexts: ["documents"],
        capabilities: ["configure-runtime", "inspect-system"],
      };
    case "skills":
    case "trajectories":
    case "relationships":
    case "memories":
      return {
        view: "documents",
        primaryContext: "documents",
        secondaryContexts: ["admin", "social_posting"],
        capabilities: ["documents", "memory", "relationships"],
      };
    case "views":
      return {
        view: dynamicViewNameFromPath(viewPath),
        primaryContext: "apps",
        secondaryContexts: ["admin", "documents"],
        capabilities: ["view-actions", "inspect-view", "navigate-view"],
      };
    default:
      return {
        view: "chat",
        primaryContext: "general",
        secondaryContexts: [],
        capabilities: ["general-chat"],
      };
  }
}

function buildChatViewMetadata(
  tab: Tab,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const navigationPath =
    typeof window === "undefined" ? "/" : getWindowNavigationPath();
  const normalizedViewPath = normalizeViewPath(navigationPath);
  const viewRouting = resolveChatViewRouting(tab, normalizedViewPath);
  const existingRouting = asRecord(metadata?.[CONTEXT_ROUTING_METADATA_KEY]);
  const secondaryContexts = uniq([
    ...viewRouting.secondaryContexts,
    ...asStringList(existingRouting?.secondaryContexts),
    viewRouting.primaryContext,
  ]);

  return {
    ...(metadata ?? {}),
    uiView: viewRouting.view,
    uiTab: tab,
    uiViewPath: normalizedViewPath,
    uiViewCapabilities: viewRouting.capabilities,
    [CONTEXT_ROUTING_METADATA_KEY]: {
      ...(existingRouting ?? {}),
      primaryContext: viewRouting.primaryContext,
      secondaryContexts,
    },
  };
}

export interface QueuedChatSend {
  rawInput: string;
  channelType: ConversationChannelType;
  conversationId?: string | null;
  images?: ImageAttachment[];
  metadata?: Record<string, unknown>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

// ── Deps interface ──────────────────────────────────────────────────

export interface UseChatSendDeps {
  // Translation
  t: (key: string) => string;

  // UI state
  uiLanguage: string;
  tab: Tab;

  // Chat state
  activeConversationId: string | null;
  /** Stable ref whose .current mirrors the latest ptySessions array. */
  ptySessionsRef: MutableRefObject<CodingAgentSession[]>;

  // Setters
  setChatInput: (v: string) => void;
  setChatSending: (v: boolean) => void;
  setChatFirstTokenReceived: (v: boolean) => void;
  /** Set/clear the live server-reported phase of the in-flight turn (#8813).
   *  Fed by the chat-send SSE `onStatus`; cleared when the turn settles. */
  setServerTurnStatus: (status: ChatTurnStatus | null) => void;
  setChatLastUsage: (v: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string | undefined;
    updatedAt: number;
  }) => void;
  setChatPendingImages: (v: ImageAttachment[]) => void;
  setConversations: (
    v: Conversation[] | ((prev: Conversation[]) => Conversation[]),
  ) => void;
  setActiveConversationId: (v: string | null) => void;
  setCompanionMessageCutoffTs: (v: number) => void;
  setConversationMessages: (
    v:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
  setUnreadConversations: (
    v: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void;
  setActionNotice: (
    text: string,
    tone: "success" | "error" | "info",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;

  // Refs
  activeConversationIdRef: MutableRefObject<string | null>;
  chatInputRef: MutableRefObject<string>;
  chatPendingImagesRef: MutableRefObject<ImageAttachment[]>;
  conversationsRef: MutableRefObject<Conversation[]>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  chatAbortRef: MutableRefObject<AbortController | null>;
  chatSendBusyRef: MutableRefObject<boolean>;
  chatSendNonceRef: MutableRefObject<number>;

  // Loaders
  loadConversations: () => Promise<Conversation[] | null>;
  loadConversationMessages: (
    convId: string,
  ) => Promise<LoadConversationMessagesResult>;

  // Cloud state
  elizaCloudEnabled: boolean;
  elizaCloudConnected: boolean;
  pollCloudCredits: () => Promise<boolean>;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useChatSend(deps: UseChatSendDeps) {
  const {
    t,
    uiLanguage,
    tab,
    activeConversationId,
    ptySessionsRef,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setServerTurnStatus,
    setChatLastUsage,
    setChatPendingImages,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setUnreadConversations,
    setActionNotice,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    loadConversations,
    loadConversationMessages,
    elizaCloudEnabled,
    elizaCloudConnected,
    pollCloudCredits,
  } = deps;

  const chatSendQueueRef = useRef<QueuedChatSend[]>([]);
  const activeChatTurnRef = useRef<ActiveChatTurn | null>(null);

  // Freeze-on-shared (cloud-agent handoff, PR2). While a shared→dedicated
  // handoff is migrating, the user is still pointed at the SHARED agent but the
  // shared transcript has already been (or is about to be) snapshotted. The
  // import endpoint is populated-room skip-all idempotent, so any message that
  // reaches the shared history AFTER the snapshot is silently lost — a re-import
  // inserts zero. To guarantee no loss we DON'T send outgoing messages to the
  // shared agent during the window: they sit in `chatSendQueueRef` (un-drained)
  // and are flushed once `onSwitch` has re-pointed the client at the dedicated
  // container (which already holds the copied history). When no handoff is in
  // flight this stays false → the drain runs exactly as before (byte-identical
  // when `preferSharedCloudTier` is off, since no `migrating` phase ever fires).
  const handoffFrozenRef = useRef(false);

  // Streaming-commit throttle.
  // The SSE `onToken` callback fires once per token (often >60/sec on a fast
  // model). Instead of committing each one, the latest cumulative text is parked
  // here and applied at most once per animation frame. Chat sends are serialized
  // through the queue, so a single in-flight buffer is sufficient.
  const streamingFlushRef = useRef<{
    messageId: string;
    pendingText: string | null;
    frameId: number | null;
  }>({ messageId: "", pendingText: null, frameId: null });

  // Apply whatever cumulative text is parked for the in-flight turn, then clear
  // the pending slot. Safe to call when nothing is pending (no-op).
  const flushStreamingText = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (buffer.frameId !== null) {
      cancelAnimationFrame(buffer.frameId);
      buffer.frameId = null;
    }
    if (buffer.pendingText === null) return;
    const fullText = buffer.pendingText;
    buffer.pendingText = null;
    applyStreamingTextModification(setConversationMessages, {
      messageId: buffer.messageId,
      mode: "replace",
      fullText,
    });
  }, [setConversationMessages]);

  // Park the latest cumulative text for `messageId` and ensure a single rAF is
  // scheduled to commit it. Repeated calls within a frame overwrite the parked
  // text without scheduling additional frames: N tokens become at most one
  // commit per frame.
  const scheduleStreamingText = useCallback(
    (messageId: string, fullText: string) => {
      const buffer = streamingFlushRef.current;
      // A new turn started — drop any stale parked text from the prior turn.
      if (buffer.messageId !== messageId) {
        if (buffer.frameId !== null) cancelAnimationFrame(buffer.frameId);
        buffer.messageId = messageId;
        buffer.frameId = null;
      }
      buffer.pendingText = fullText;
      if (buffer.frameId !== null) return;
      buffer.frameId = requestAnimationFrame(() => {
        buffer.frameId = null;
        if (buffer.pendingText === null) return;
        const next = buffer.pendingText;
        buffer.pendingText = null;
        applyStreamingTextModification(setConversationMessages, {
          messageId: buffer.messageId,
          mode: "replace",
          fullText: next,
        });
      });
    },
    [setConversationMessages],
  );

  // Cancel any in-flight frame on unmount so a late rAF never commits into a
  // torn-down tree.
  useEffect(() => {
    const buffer = streamingFlushRef.current;
    return () => {
      if (buffer.frameId !== null) {
        cancelAnimationFrame(buffer.frameId);
        buffer.frameId = null;
      }
      buffer.pendingText = null;
    };
  }, []);

  const resolveQueuedChatSends = useCallback((): string => {
    const queued = chatSendQueueRef.current.splice(0);
    if (queued.length === 0) return "";
    for (const turn of queued) {
      turn.resolve();
    }
    // These turns were accepted ("send another" while a reply streamed), the
    // composer was cleared at enqueue, and their optimistic bubble only paints
    // at drain — so an interrupt here (new chat / conversation switch) would
    // otherwise vanish the user's words with no trace (#10700's "no message is
    // lost" guarantee). Mirror the cold-open create-failure path: restore the
    // text to the composer and say why. Returned so a caller that wipes the
    // draft AFTER interrupting (new chat) can re-apply the restore.
    const restored = queued
      .map((turn) => turn.rawInput.trim())
      .filter((text) => text.length > 0)
      .join("\n");
    if (restored) {
      setChatInput(restored);
      setActionNotice(
        "Your unsent message was restored to the input.",
        "info",
        6_000,
      );
    }
    return restored;
  }, [setActionNotice, setChatInput]);

  const resolveConversationRoomId = useCallback(
    async (
      conversationId: string,
      knownRoomId: string | null | undefined,
    ): Promise<string | null> => {
      if (knownRoomId?.trim()) return knownRoomId.trim();

      const cachedRoomId = conversationsRef.current
        .find((conversation) => conversation.id === conversationId)
        ?.roomId?.trim();
      if (cachedRoomId) return cachedRoomId;

      const refreshed = await loadConversations();
      return (
        refreshed
          ?.find((conversation) => conversation.id === conversationId)
          ?.roomId?.trim() ?? null
      );
    },
    [conversationsRef, loadConversations],
  );

  const interruptActiveChatPipeline = useCallback((): string => {
    const restoredQueuedText = resolveQueuedChatSends();
    const activeTurn = activeChatTurnRef.current;
    if (activeTurn?.roomId) {
      abortServerConversationTurn(activeTurn.roomId, "ui-chat-stop");
    }
    if (activeTurn?.abortServerTurn) {
      activeTurn.controller.signal.removeEventListener(
        "abort",
        activeTurn.abortServerTurn,
      );
    }
    activeTurn?.controller.abort();
    chatAbortRef.current?.abort();
    // Commit any parked partial text (so a stopped turn keeps what the user saw)
    // and cancel the pending frame so it can't fire after the stop.
    flushStreamingText();
    activeChatTurnRef.current = null;
    chatAbortRef.current = null;
    setChatSending(false);
    setChatFirstTokenReceived(false);
    setServerTurnStatus(null);
    return restoredQueuedText;
  }, [
    chatAbortRef,
    flushStreamingText,
    resolveQueuedChatSends,
    setChatFirstTokenReceived,
    setServerTurnStatus,
    setChatSending,
  ]);

  const appendLocalCommandTurn = useCallback(
    (userText: string, assistantText: string) => {
      const now = Date.now();
      const nonce = Math.random().toString(36).slice(2, 8);
      setConversationMessages((prev: ConversationMessage[]) => [
        ...prev,
        {
          id: `local-user-${now}-${nonce}`,
          role: "user",
          text: userText,
          timestamp: now,
        },
        {
          id: `local-assistant-${now}-${nonce}`,
          role: "assistant",
          text: assistantText,
          timestamp: now,
          source: "local_command",
        },
      ]);
    },
    [setConversationMessages],
  );

  const tryHandlePrefixedChatCommand = useCallback(
    async (
      rawText: string,
    ): Promise<{ handled: boolean; rewrittenText?: string }> => {
      const slash = parseSlashCommandInput(rawText);
      if (slash) {
        const savedCommand = loadSavedCustomCommands().find(
          (command) => normalizeSlashCommandName(command.name) === slash.name,
        );
        if (savedCommand) {
          const rewrittenText = expandSavedCustomCommand(
            savedCommand.text,
            slash.argsRaw,
          );
          if (!rewrittenText.trim()) {
            appendLocalCommandTurn(
              rawText,
              `Saved command "/${slash.name}" is empty.`,
            );
            return { handled: true };
          }
          return { handled: false, rewrittenText };
        }

        if (slash.name === "commands") {
          const customActions = (await client.listCustomActions()).filter(
            (action) => action.enabled,
          );
          const customCommandNames = customActions
            .map((action) => `/${action.name.toLowerCase()}`)
            .sort();
          const savedCommandNames = loadSavedCustomCommands()
            .map((command) => `/${normalizeSlashCommandName(command.name)}`)
            .sort();
          const lines = [
            formatSearchBullet("Saved / commands", savedCommandNames),
            formatSearchBullet("Custom action / commands", customCommandNames),
            "Use #remember ... to save memory notes. Use #memory or #documents to target retrieval.",
            "Use $query for a quick, non-persistent context answer.",
          ];
          appendLocalCommandTurn(rawText, lines.join("\n\n"));
          return { handled: true };
        }

        let customActions: CustomActionDef[] = [];
        try {
          customActions = (await client.listCustomActions()).filter(
            (action) => action.enabled,
          );
        } catch {
          // If custom actions can't be loaded, fall back to normal slash routing.
          return { handled: false };
        }

        const customAction = customActions.find(
          (action) =>
            `/${normalizeCustomActionName(action.name).toLowerCase()}` ===
            slash.name,
        );
        if (customAction) {
          const { params, missingRequired } = parseCustomActionParams(
            customAction,
            slash.argsRaw,
          );
          if (missingRequired.length > 0) {
            appendLocalCommandTurn(
              rawText,
              `Missing required parameter(s): ${missingRequired.join(", ")}`,
            );
            return { handled: true };
          }

          const result = await client.testCustomAction(customAction.id, params);
          if (!result.ok) {
            appendLocalCommandTurn(
              rawText,
              `Custom action "${customAction.name}" failed: ${
                result.error ?? "unknown error"
              }`,
            );
            return { handled: true };
          }

          appendLocalCommandTurn(
            rawText,
            result.output?.trim() || `(no output from ${customAction.name})`,
          );
          return { handled: true };
        }
      }

      if (rawText.startsWith("#")) {
        const commandBody = rawText.slice(1).trim();
        if (!commandBody) {
          appendLocalCommandTurn(
            rawText,
            "Usage: #remember <text>, #memory <query>, #documents <query>, or #<query>.",
          );
          return { handled: true };
        }

        const lower = commandBody.toLowerCase();
        if (
          lower.startsWith("remember ") ||
          lower.startsWith("remmeber ") ||
          lower.startsWith("save ")
        ) {
          const memoryText = commandBody
            .replace(/^(remember|remmeber|save)\s+/i, "")
            .trim();
          if (!memoryText) {
            appendLocalCommandTurn(rawText, "Nothing to remember.");
            return { handled: true };
          }
          await client.rememberMemory(memoryText);
          appendLocalCommandTurn(rawText, `Saved memory note: "${memoryText}"`);
          return { handled: true };
        }

        let scope: "memory" | "documents" | "all" = "all";
        let query = commandBody;
        if (lower.startsWith("memory ")) {
          scope = "memory";
          query = commandBody.slice("memory ".length).trim();
        } else if (lower.startsWith("documents ")) {
          scope = "documents";
          query = commandBody.slice("documents ".length).trim();
        } else if (lower.startsWith("all ")) {
          scope = "all";
          query = commandBody.slice("all ".length).trim();
        }

        if (!query) {
          appendLocalCommandTurn(rawText, "Search query cannot be empty.");
          return { handled: true };
        }

        const [memoryResult, documentResult] = await Promise.all([
          scope === "documents"
            ? Promise.resolve(null)
            : client.searchMemory(query, { limit: 6 }),
          scope === "memory"
            ? Promise.resolve(null)
            : client.searchDocuments(query, { threshold: 0.2, limit: 6 }),
        ]);

        const memoryLines =
          memoryResult?.results.map(
            (item, index) =>
              `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()}`,
          ) ?? [];
        const documentLines =
          documentResult?.results.map(
            (item, index) =>
              `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()} (sim ${item.similarity.toFixed(2)})`,
          ) ?? [];

        appendLocalCommandTurn(
          rawText,
          [
            scope === "memory"
              ? "Memory search"
              : scope === "documents"
                ? "Knowledge search"
                : "Memory + knowledge search",
            "",
            scope === "documents"
              ? ""
              : formatSearchBullet("Memories", memoryLines),
            scope === "memory"
              ? ""
              : formatSearchBullet("Knowledge", documentLines),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        return { handled: true };
      }

      if (rawText.startsWith("$")) {
        const queryRaw = rawText.slice(1).trim();
        if (queryRaw) {
          appendLocalCommandTurn(
            rawText,
            "Use bare `$` only. `$ <text>` is not supported.",
          );
          return { handled: true };
        }
        const query =
          "What is most relevant from memory and knowledge right now?";

        const quick = await client.quickContext(query, { limit: 6 });
        const memoryLines = quick.memories.map(
          (item, index) =>
            `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()}`,
        );
        const documentLines = quick.documents.map(
          (item, index) =>
            `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()} (sim ${item.similarity.toFixed(2)})`,
        );
        appendLocalCommandTurn(
          rawText,
          [
            quick.answer,
            "",
            formatSearchBullet("Memories used", memoryLines),
            formatSearchBullet("Knowledge used", documentLines),
          ].join("\n"),
        );
        return { handled: true };
      }

      return { handled: false };
    },
    [appendLocalCommandTurn],
  );

  // Drop the empty assistant placeholder bubble (a temp-resp-* that never got
  // any streamed text) while preserving the user's message. Shared by every
  // send-failure branch so the predicate lives in one place and can't drift.
  const dropEmptyAssistantPlaceholder = useCallback(
    (assistantMsgId: string) => {
      setConversationMessages((prev) =>
        prev.filter(
          (message) => !(message.id === assistantMsgId && !message.text.trim()),
        ),
      );
    },
    [setConversationMessages],
  );

  // Re-attach a stopped/interrupted turn's partial reply after the post-turn
  // history reload full-replaced it away. The server frequently does NOT persist
  // a reply that was cut off mid-stream, so the reload returns a thread without
  // it and the bubble the user was watching stream in silently vanishes. Append
  // the partial as an interrupted assistant turn — but ONLY when the reloaded
  // thread's last message is not already an assistant turn (i.e. the server has
  // no reply for this turn). When the server DID persist a reply the reload
  // already carries it, so it is kept as-is and never duplicated.
  const reattachInterruptedPartial = useCallback(
    (partialText: string) => {
      const text = partialText.trim();
      if (!text) return;
      setConversationMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") return prev;
        return [
          ...prev,
          {
            id: `local-interrupted-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            role: "assistant",
            text,
            timestamp: Date.now(),
            interrupted: true,
          },
        ];
      });
    },
    [setConversationMessages],
  );

  // Re-attach a user turn the post-turn history reload evicted. The reload
  // full-replaces the thread with server truth; when the server never
  // persisted the turn — a send during local-model warm-up where the
  // runtime-ready hold expired (503), or a runtime that answered with nothing
  // and stored nothing — the reload returns a thread WITHOUT the user's
  // message and the optimistic bubble the user just watched render silently
  // vanishes (#11670). Restore the bubble together with a retryable failed
  // assistant turn so the send fails loudly and one tap re-delivers it once
  // the model is ready. No-op when the reload carries the turn (server
  // persisted it) or never replaced local state (transient reload failure).
  const restoreEvictedUserTurn = useCallback(
    (turn: {
      userMsgId: string;
      assistantMsgId: string;
      text: string;
      timestamp: number;
      attachments?: ConversationMessage["attachments"];
    }) => {
      const sentText = turn.text.trim();
      if (!sentText) return;
      setConversationMessages((prev) => {
        if (sentUserTurnPresent(prev, sentText, turn.timestamp)) return prev;
        return [
          ...prev,
          {
            id: turn.userMsgId,
            role: "user",
            text: turn.text,
            timestamp: turn.timestamp,
            ...(turn.attachments?.length
              ? { attachments: turn.attachments }
              : {}),
          },
          {
            id: `${turn.assistantMsgId}-undelivered`,
            role: "assistant",
            text: UNDELIVERED_TURN_NOTICE,
            timestamp: Date.now(),
            failureKind: "provider_issue",
          },
        ];
      });
    },
    [setConversationMessages],
  );

  const runQueuedChatSend = useCallback(
    async (turn: Omit<QueuedChatSend, "resolve" | "reject">) => {
      const hasAttachedImages = Boolean(turn.images?.length);
      const rawText = turn.rawInput.trim();
      if (!rawText && !hasAttachedImages) return;

      const channelType = turn.channelType;
      const imagesToSend = turn.images;
      let controller: AbortController | null = null;
      let abortServerTurn: (() => void) | null = null;
      let convRoomId: string | null = null;

      let text = hasAttachedImages
        ? rawText || "Please review the attached image."
        : rawText;
      if (rawText) {
        let commandResult: { handled: boolean; rewrittenText?: string };
        try {
          commandResult = await tryHandlePrefixedChatCommand(rawText);
        } catch (err) {
          appendLocalCommandTurn(
            rawText,
            `Command failed: ${err instanceof Error ? err.message : "unknown error"}`,
          );
          return;
        }
        if (commandResult.handled) {
          return;
        }
        if (
          typeof commandResult.rewrittenText === "string" &&
          commandResult.rewrittenText.trim()
        ) {
          text = commandResult.rewrittenText.trim();
        }
      }

      let convId: string =
        turn.conversationId ?? activeConversationIdRef.current ?? "";
      if (!convId) {
        try {
          const { conversation: rawConversation } =
            await client.createConversation(undefined, {
              lang: uiLanguage,
            });
          if (!isConversationRecord(rawConversation)) {
            throw new Error(
              "Conversation creation returned an invalid payload.",
            );
          }
          const conversation = rawConversation;
          const nextCutoffTs = Date.now();
          setConversations((prev) => [conversation, ...prev]);
          setActiveConversationId(conversation.id);
          activeConversationIdRef.current = conversation.id;
          setCompanionMessageCutoffTs(nextCutoffTs);
          convId = conversation.id;
          convRoomId = conversation.roomId;
        } catch {
          // First-message conversation creation failed (cold open on weak
          // signal). The composer was already cleared upstream and the
          // optimistic bubble hasn't rendered yet, so a bare return drops the
          // user's text with no trace. Restore it to the composer + surface the
          // failure so the first impression isn't a vanished message.
          setChatInput(rawText);
          setActionNotice(
            "Couldn't start the conversation — check your connection and try again. Your message was restored.",
            "error",
            8_000,
          );
          return;
        }
      }

      client.sendWsMessage({
        type: "active-conversation",
        conversationId: convId,
      });

      const activeConv = conversationsRef.current.find((c) => c.id === convId);
      convRoomId = await resolveConversationRoomId(convId, convRoomId);
      if (
        activeConv &&
        (!activeConv.title ||
          activeConv.title === "New Chat" ||
          activeConv.title === "companion.newChat" ||
          activeConv.title === "conversations.newChatTitle")
      ) {
        const fallbackTitle =
          text.length > 15 ? `${text.slice(0, 15)}...` : text;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId ? { ...c, title: fallbackTitle } : c,
          ),
        );
      }

      const now = Date.now();
      const userMsgId = `temp-${now}`;
      const assistantMsgId = `temp-resp-${now}`;

      // Echo uploaded images on the optimistic user bubble immediately, from the
      // base64 the client already holds. The post-turn history reload replaces
      // this with the server's persisted served-URL attachment.
      const optimisticAttachments = imagesToSend?.length
        ? imagesToSend.map((img, i) => ({
            id: `${userMsgId}-img-${i}`,
            url: `data:${img.mimeType};base64,${img.data}`,
            // Derive the kind from the MIME type — not every pending attachment
            // is an image (e.g. a `text/markdown` transcript), and hardcoding
            // "image" mis-tagged the optimistic bubble until the post-turn
            // reload corrected it.
            contentType: optimisticAttachmentKind(img.mimeType),
            ...(img.name ? { title: img.name } : {}),
            mimeType: img.mimeType,
            source: "client_chat",
            ...(img.transcriptId ? { transcriptId: img.transcriptId } : {}),
            ...(img.thumbnail
              ? {
                  thumbnailUrl: `data:${img.thumbnail.mimeType};base64,${img.thumbnail.data}`,
                }
              : {}),
          }))
        : undefined;

      setCompanionMessageCutoffTs(now);
      setConversationMessages((prev: ConversationMessage[]) => [
        ...prev,
        {
          id: userMsgId,
          role: "user",
          text,
          timestamp: now,
          ...(optimisticAttachments
            ? { attachments: optimisticAttachments }
            : {}),
        },
        { id: assistantMsgId, role: "assistant", text: "", timestamp: now },
      ]);
      setChatFirstTokenReceived(false);

      controller = new AbortController();
      chatAbortRef.current = controller;
      abortServerTurn = () => {
        abortServerConversationTurn(convRoomId, "ui-chat-abort");
      };
      controller.signal.addEventListener("abort", abortServerTurn, {
        once: true,
      });
      activeChatTurnRef.current = {
        controller,
        roomId: convRoomId,
        abortServerTurn,
      };
      let streamedAssistantText = "";

      try {
        const data = await client.sendConversationMessageStream(
          convId,
          text,
          (token, accumulatedText) => {
            const nextText =
              typeof accumulatedText === "string"
                ? accumulatedText
                : mergeStreamingText(streamedAssistantText, token);
            if (nextText === streamedAssistantText) return;
            streamedAssistantText = nextText;
            setChatFirstTokenReceived(true);
            // Coalesce tokens into at most one commit per frame; the parked text is
            // flushed synchronously below before any terminal modification.
            scheduleStreamingText(assistantMsgId, nextText);
          },
          channelType,
          controller.signal,
          imagesToSend,
          turn.metadata,
          // Live server phase → the rich status indicator. Additive; the reply
          // streams through onToken above regardless.
          (status) => setServerTurnStatus(status),
        );

        // Commit any token parked by the throttle before the terminal
        // drop/complete/fail/interrupt — no streamed tokens may be lost.
        flushStreamingText();

        if (!data.text.trim()) {
          if (data.failureKind) {
            // Empty reply but the server flagged a failure class — surface the
            // gate UI (e.g. "Connect a provider") instead of silently dropping
            // the turn. The failure branch below is an `else if`, unreachable
            // once the text is empty, so it must be handled here.
            applyStreamingTextModification(setConversationMessages, {
              messageId: assistantMsgId,
              mode: "fail",
              failureKind: data.failureKind,
            });
          } else {
            applyStreamingTextModification(setConversationMessages, {
              messageId: assistantMsgId,
              mode: "drop",
            });
          }
        } else if (
          shouldApplyFinalStreamText(streamedAssistantText, data.text) ||
          data.reasoning
        ) {
          applyStreamingTextModification(setConversationMessages, {
            messageId: assistantMsgId,
            mode: "complete",
            fullText: data.text,
            ...(data.failureKind ? { failureKind: data.failureKind } : {}),
            ...(data.accountConnect
              ? { accountConnect: data.accountConnect }
              : {}),
            ...(data.reasoning ? { reasoning: data.reasoning } : {}),
          });
        } else if (data.failureKind) {
          // Streaming text already matched but the server flagged a failure
          // class — stamp it on the assistant turn so the renderer can swap
          // in the gate UI (e.g. "Connect a provider").
          applyStreamingTextModification(setConversationMessages, {
            messageId: assistantMsgId,
            mode: "fail",
            failureKind: data.failureKind,
          });
        } else if (data.accountConnect) {
          // Streaming text already matched but the server flagged a
          // "connect another account" request — stamp it (via complete, which
          // carries accountConnect) so the renderer swaps in the
          // AccountConnectBlock while keeping the already-streamed text.
          applyStreamingTextModification(setConversationMessages, {
            messageId: assistantMsgId,
            mode: "complete",
            fullText: data.text,
            accountConnect: data.accountConnect,
          });
        }
        if (data.usage) {
          setChatLastUsage({
            promptTokens: data.usage.promptTokens,
            completionTokens: data.usage.completionTokens,
            totalTokens: data.usage.totalTokens,
            model: data.usage.model,
            updatedAt: Date.now(),
          });
        }

        // A stopped / dropped turn keeps a partial reply the user was watching.
        // Snapshot it BEFORE the reload below (which full-replaces local state
        // with the server's copy) so it can be re-attached if the server never
        // persisted it.
        const interruptedPartial =
          !data.completed && streamedAssistantText.trim()
            ? data.text.trim() || streamedAssistantText
            : null;
        if (interruptedPartial) {
          applyStreamingTextModification(setConversationMessages, {
            messageId: assistantMsgId,
            mode: "interrupt",
          });
        }

        // Action callbacks can persist additional assistant turns that are not
        // mirrored by the optimistic streaming draft in local state.
        if (activeConversationIdRef.current === convId) {
          await loadConversationMessages(convId);
          // The reload above full-replaces the thread; a stopped reply is often
          // NOT persisted server-side, so re-attach the partial the user watched
          // stream in (no-op / no duplicate when the server kept it).
          if (interruptedPartial) {
            reattachInterruptedPartial(interruptedPartial);
          }
          // Same full-replace hazard for the USER turn: a send during agent
          // warm-up can complete with nothing persisted, and the reload then
          // evicts the user's bubble (#11670). Restore it with a retryable
          // failed turn; no-op when the server persisted it.
          restoreEvictedUserTurn({
            userMsgId,
            assistantMsgId,
            text,
            timestamp: now,
            ...(optimisticAttachments
              ? { attachments: optimisticAttachments }
              : {}),
          });
        }

        const userMessageCount = conversationMessagesRef.current.filter(
          (message) =>
            message.role === "user" && !message.id.startsWith("temp-"),
        ).length;

        if (
          userMessageCount === 1 &&
          data.completed !== false &&
          data.text.trim() &&
          !data.failureKind &&
          !isCloudAgentBase(client.getBaseUrl())
        ) {
          void client
            .renameConversation(convId, "", { generate: true })
            .then(() => {
              void loadConversations();
            })
            .catch((err) => {
              console.warn(
                "Failed to generate conversation title",
                err instanceof Error ? err.message : err,
              );
              void loadConversations();
            });
        } else {
          void loadConversations();
        }

        if (elizaCloudEnabled || elizaCloudConnected) {
          void pollCloudCredits();
        }
      } catch (err) {
        // Commit any throttled-but-uncommitted token first so an abort/error
        // never drops a placeholder the user already saw fill with partial text.
        flushStreamingText();
        const abortError = err as Error;
        if (abortError.name === "AbortError" || controller?.signal.aborted) {
          dropEmptyAssistantPlaceholder(assistantMsgId);
          return;
        }

        // A terminal SSE `error` event that carried a structured gate must
        // surface that gate on the assistant turn — the same UI the completed
        // response shows — instead of collapsing to a generic error notice that
        // loses the actionable signal (#10231). `no_provider` → the provider
        // gate; a connect-account request → the AccountConnectBlock.
        if (
          isStreamGenerationError(err) &&
          (err.failureKind || err.accountConnect)
        ) {
          if (err.failureKind) {
            applyStreamingTextModification(setConversationMessages, {
              messageId: assistantMsgId,
              mode: "fail",
              failureKind: err.failureKind,
            });
          } else if (err.accountConnect) {
            applyStreamingTextModification(setConversationMessages, {
              messageId: assistantMsgId,
              mode: "complete",
              fullText: "",
              accountConnect: err.accountConnect,
            });
          }
          return;
        }

        const status = (err as { status?: number }).status;
        if (status === 404) {
          // A 404 on send usually means the conversation row was deleted —
          // recreate it and replay. But on an Eliza Cloud agent base the 404 can
          // instead mean the AGENT itself was deleted / is unreachable, in which
          // case createConversation() ALSO 404s. Distinguish the two so we don't
          // silently drop the user's message on a dead agent.
          let conversation: Conversation;
          try {
            const { conversation: rawConversation } =
              await client.createConversation();
            if (!isConversationRecord(rawConversation)) {
              throw new Error(
                "Conversation creation returned an invalid payload.",
              );
            }
            conversation = rawConversation;
          } catch (createErr) {
            const createStatus = (createErr as { status?: number }).status;
            // Conversation recreation also failed against a cloud agent base —
            // the agent is gone/unreachable. Surface the failure and KEEP the
            // user's message (drop only the empty assistant placeholder) so the
            // user can retry or re-select an agent instead of losing their text.
            if (createStatus === 404 && isCloudAgentBase(client.getBaseUrl())) {
              setActionNotice(
                "This agent is no longer reachable — it may have been deleted. Your message was kept; pick another agent and try again.",
                "error",
                10_000,
              );
              dropEmptyAssistantPlaceholder(assistantMsgId);
              return;
            }
            // Non-cloud base, or a different create failure — preserve the prior
            // behaviour (drop the empty assistant placeholder).
            dropEmptyAssistantPlaceholder(assistantMsgId);
            return;
          }

          try {
            const nextCutoffTs = Date.now();
            setConversations((prev) => [conversation, ...prev]);
            setActiveConversationId(conversation.id);
            activeConversationIdRef.current = conversation.id;
            setCompanionMessageCutoffTs(nextCutoffTs);
            client.sendWsMessage({
              type: "active-conversation",
              conversationId: conversation.id,
            });

            // Seed the recreated conversation with the user turn + an empty
            // assistant placeholder, then REPLAY as a token stream — the 404
            // recovery must stream like the primary send, not pop the whole
            // reply in at once with the non-streaming endpoint (#10231).
            const replayUserId = `temp-${Date.now()}`;
            const replayAssistantId = `temp-resp-${Date.now()}`;
            // Seed unfiltered (like the primary send path) — the empty assistant
            // placeholder must survive so streamed tokens have a target;
            // filterRenderableConversationMessages would drop an empty turn.
            setConversationMessages([
              { id: replayUserId, role: "user", text, timestamp: Date.now() },
              {
                id: replayAssistantId,
                role: "assistant",
                text: "",
                timestamp: Date.now(),
              },
            ]);

            let replayStreamedText = "";
            const retryData = await client.sendConversationMessageStream(
              conversation.id,
              text,
              (token, accumulatedText) => {
                const nextText =
                  typeof accumulatedText === "string"
                    ? accumulatedText
                    : mergeStreamingText(replayStreamedText, token);
                if (nextText === replayStreamedText) return;
                replayStreamedText = nextText;
                setChatFirstTokenReceived(true);
                scheduleStreamingText(replayAssistantId, nextText);
              },
              channelType,
              controller?.signal,
              imagesToSend,
              turn.metadata,
              (serverStatus) => setServerTurnStatus(serverStatus),
            );

            // Commit any throttle-parked token before the terminal modification.
            flushStreamingText();

            if (!retryData.text.trim()) {
              applyStreamingTextModification(setConversationMessages, {
                messageId: replayAssistantId,
                ...(retryData.failureKind
                  ? { mode: "fail", failureKind: retryData.failureKind }
                  : { mode: "drop" }),
              });
            } else {
              applyStreamingTextModification(setConversationMessages, {
                messageId: replayAssistantId,
                mode: "complete",
                fullText: retryData.text,
                ...(retryData.failureKind
                  ? { failureKind: retryData.failureKind }
                  : {}),
                ...(retryData.reasoning
                  ? { reasoning: retryData.reasoning }
                  : {}),
              });
            }
          } catch {
            dropEmptyAssistantPlaceholder(assistantMsgId);
          }
        } else {
          // Non-abort, non-404 send failure (network/timeout/5xx/auth/429/4xx).
          // Drop the empty assistant placeholder but KEEP the user's message,
          // and surface a status-specific notice so a stalled turn is never
          // silent dead air (the typing indicator stalls at ~30s while the SSE
          // idle timeout is 60s — without this the user just sees the dots
          // vanish and nothing replace them, reading as "my message was lost").
          dropEmptyAssistantPlaceholder(assistantMsgId);
          const isAuth = status === 401 || status === 403;
          if (getSendValidationFailureMessage(err) !== null) {
            // A 4xx validation rejection (oversized/unsupported attachment,
            // malformed payload) means the server REFUSED the message before it
            // persisted: the composer was already cleared at enqueue and the
            // reconcile reload below wipes the optimistic bubble, so without a
            // restore the user's text + attachments would be irrecoverably
            // destroyed on a primary flow (e.g. a phone-photo upload). Mirror
            // the cold-open create-failure path: put the draft — text AND
            // pending attachments (the pending-images state holds the same
            // ImageAttachment shape that was sent) — back in the composer, and
            // say exactly why the server rejected it, because resending the
            // same payload unchanged would fail identically.
            if (rawText) setChatInput(rawText);
            if (imagesToSend?.length) setChatPendingImages([...imagesToSend]);
            const restored =
              rawText && imagesToSend?.length
                ? "Your text and attachments were restored to the input."
                : imagesToSend?.length
                  ? "Your attachments were restored to the input."
                  : "Your message was restored to the input.";
            setActionNotice(
              `${buildSendFailureNotice(err)} ${restored}`,
              "error",
              10_000,
            );
          } else {
            setActionNotice(buildSendFailureNotice(err), "error", 8_000);
          }
          // Reconcile from the server for non-auth errors — loadConversationMessages
          // no longer wipes the thread on transient failures (404-only clear), so
          // this is safe; skip on auth where the reload would just fail again.
          if (!isAuth) {
            await loadConversationMessages(convId);
            // When the server refused the turn before persisting it (e.g. the
            // 503 warm-up gate), the reconcile just evicted the user's bubble —
            // the "KEEP the user's message" promise above becomes a lie
            // (#11670). Restore it with a retryable failed turn. Validation
            // rejects are excluded: their draft went back to the composer
            // above, so re-attaching the bubble would duplicate it.
            if (
              getSendValidationFailureMessage(err) === null &&
              activeConversationIdRef.current === convId
            ) {
              restoreEvictedUserTurn({
                userMsgId,
                assistantMsgId,
                text,
                timestamp: now,
                ...(optimisticAttachments
                  ? { attachments: optimisticAttachments }
                  : {}),
              });
            }
          }
        }
      } finally {
        // Belt-and-braces: cancel any frame still pending so it can't commit a
        // stale snapshot into the next turn (idempotent — every exit path above
        // already flushed).
        flushStreamingText();
        // The turn settled (done / error / abort) — drop the live status so the
        // indicator doesn't linger on a stale phase between turns.
        setServerTurnStatus(null);
        if (controller && abortServerTurn) {
          controller.signal.removeEventListener("abort", abortServerTurn);
        }
        if (chatAbortRef.current === controller) {
          chatAbortRef.current = null;
        }
        if (activeChatTurnRef.current?.controller === controller) {
          activeChatTurnRef.current = null;
        }
      }
    },
    [
      appendLocalCommandTurn,
      loadConversationMessages,
      loadConversations,
      resolveConversationRoomId,
      tryHandlePrefixedChatCommand,
      activeConversationIdRef,
      chatAbortRef,
      conversationMessagesRef.current.filter,
      conversationsRef,
      setActiveConversationId,
      setChatFirstTokenReceived,
      setServerTurnStatus,
      setChatLastUsage,
      setCompanionMessageCutoffTs,
      setConversationMessages,
      dropEmptyAssistantPlaceholder,
      reattachInterruptedPartial,
      restoreEvictedUserTurn,
      setConversations,
      setActionNotice,
      setChatInput,
      setChatPendingImages,
      uiLanguage,
      elizaCloudEnabled,
      elizaCloudConnected,
      pollCloudCredits,
      scheduleStreamingText,
      flushStreamingText,
    ],
  );

  const flushQueuedChatSends = useCallback(async () => {
    if (chatSendBusyRef.current) return;
    // Handoff in progress: hold the queue. We must NOT dispatch to the network
    // here — the live client still points at the shared agent, and anything that
    // lands on the shared history after its snapshot is lost to the skip-all
    // import. The queued turns stay put and are drained when the switch settles
    // (the freeze is cleared and this is re-invoked, now pointed at the
    // dedicated container). The composer is already cleared + `setChatSending`
    // is on, so the user sees their message accepted, not dropped.
    if (handoffFrozenRef.current) {
      setChatSending(true);
      return;
    }
    chatSendBusyRef.current = true;
    setChatSending(true);

    try {
      while (chatSendQueueRef.current.length > 0) {
        // Re-check the freeze EACH iteration: a handoff can begin (`migrating`)
        // while an earlier turn is mid-`await` here, and `sendChatText` can
        // enqueue a new turn during that await. Without this guard the loop
        // would drain that newly-queued turn to the SHARED agent after its
        // snapshot — re-opening the skip-all-import loss window the freeze
        // exists to close. `break` leaves the not-yet-shifted turns queued; the
        // terminal-phase handler re-invokes this flush after the client base is
        // repointed at the dedicated, so they land there exactly once.
        if (handoffFrozenRef.current) break;
        const nextTurn = chatSendQueueRef.current.shift();
        if (!nextTurn) break;
        try {
          await runQueuedChatSend(nextTurn);
          nextTurn.resolve();
        } catch (err) {
          nextTurn.reject(err);
        }
      }
    } finally {
      chatSendBusyRef.current = false;
      setChatSending(false);
      setChatFirstTokenReceived(false);
    }
  }, [
    chatSendBusyRef,
    runQueuedChatSend,
    setChatFirstTokenReceived,
    setChatSending,
  ]);

  // Drive the freeze off the existing shared→dedicated handoff lifecycle
  // (CLOUD_HANDOFF_PHASE_EVENT). `migrating` opens the window (stop draining to
  // the shared agent); every terminal phase closes it and drains:
  //   - `switched` / `switched-empty`: `onSwitch` has already re-pointed the
  //     client at the dedicated container (it runs INSIDE the handoff before the
  //     phase is dispatched), so the drain now delivers the queued messages to
  //     the dedicated — exactly where the copied history lives.
  //   - `timed-out` / `failed`: no switch happened, the user safely stays on the
  //     working shared agent, so unfreeze and let the queue flow to the shared
  //     agent as normal (the snapshot never landed, nothing to lose).
  // Without a handoff this listener never fires, so the queue drains inline as
  // before — no behavior change when the shared-tier flag is off.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPhase = (event: Event) => {
      const detail = (event as CustomEvent<CloudHandoffPhaseDetail>).detail;
      if (!detail) return;
      if (detail.phase === "migrating") {
        handoffFrozenRef.current = true;
        return;
      }
      // Any terminal phase ends the window. Drain whatever queued up — by now
      // the client base is the dedicated container (on a switch) or unchanged
      // (on timeout/failure), so the flush targets the right agent either way.
      if (handoffFrozenRef.current) {
        handoffFrozenRef.current = false;
        void flushQueuedChatSends();
      }
    };
    window.addEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase);
    return () => window.removeEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase);
  }, [flushQueuedChatSends]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeConversationIdRef is a ref — its .current is read at ENQUEUE time (always latest) and must NOT be a dependency, or this callback's identity churns on every conversation switch.
  const sendChatText = useCallback(
    async (
      rawInput: string,
      options?: {
        channelType?: ConversationChannelType;
        conversationId?: string | null;
        images?: ImageAttachment[];
        metadata?: Record<string, unknown>;
      },
    ) => {
      const hasAttachedImages = Boolean(options?.images?.length);
      if (!rawInput.trim() && !hasAttachedImages) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        chatSendQueueRef.current.push({
          rawInput,
          channelType: options?.channelType ?? "DM",
          // Pin the target conversation at ENQUEUE, not at drain (#10700). The
          // shell send() path (voice converse turns + tapped suggestions) omits
          // conversationId, so without this the queued turn resolved its target
          // LATE in runQueuedChatSend as `activeConversationIdRef.current` — and
          // a new-chat between enqueue and drain rerouted it to the wrong (new)
          // conversation. Snapshot the active conversation now so the turn lands
          // where it was sent. When there is NO active conversation (cold open),
          // stay null and let the drain-time create-or-join resolve it, so a
          // rapid second cold-open turn still joins the one created conversation
          // rather than spawning its own.
          conversationId:
            options?.conversationId ?? activeConversationIdRef.current ?? null,
          images: options?.images,
          metadata: buildChatViewMetadata(tab, options?.metadata),
          resolve,
          reject,
        });
        setChatSending(true);
        void flushQueuedChatSends();
      });
    },
    [flushQueuedChatSends, setChatSending, tab],
  );

  const handleChatSend = useCallback(
    async (
      channelType: ConversationChannelType = "DM",
      options?: {
        metadata?: Record<string, unknown>;
      },
    ) => {
      const claimedInput = chatInputRef.current;
      const imagesToSend = chatPendingImagesRef.current.length
        ? [...chatPendingImagesRef.current]
        : undefined;

      if (!claimedInput.trim() && !imagesToSend?.length) {
        return;
      }

      chatInputRef.current = "";
      chatPendingImagesRef.current = [];
      setChatInput("");
      setChatPendingImages([]);
      // The composer draft for this conversation is now stale — the
      // user just sent it. Clear before the debounce window so a
      // background-app pause cannot snapshot the empty-then-restored
      // value back to storage.
      clearChatDraft(activeConversationIdRef.current);

      await sendChatText(claimedInput, {
        channelType,
        conversationId: activeConversationIdRef.current,
        images: imagesToSend,
        metadata: options?.metadata,
      });
    },
    [
      activeConversationIdRef,
      chatInputRef,
      chatPendingImagesRef,
      sendChatText,
      setChatInput,
      setChatPendingImages,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversations omitted to limit rerenders
  const sendActionMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (chatSendBusyRef.current) return;
      chatSendBusyRef.current = true;
      const sendNonce = ++chatSendNonceRef.current;
      let controller: AbortController | null = null;
      let abortServerTurn: (() => void) | null = null;
      let convRoomId: string | null = null;

      try {
        let convId: string = activeConversationId ?? "";
        if (!convId) {
          try {
            const actionTitle =
              trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed;
            const { conversation: rawConversation } =
              await client.createConversation(
                actionTitle || t("common.newChat"),
              );
            if (!isConversationRecord(rawConversation)) {
              throw new Error(
                "Conversation creation returned an invalid payload.",
              );
            }
            const conversation = rawConversation;
            const nextCutoffTs = Date.now();
            setConversations((prev) => [conversation, ...prev]);
            setActiveConversationId(conversation.id);
            activeConversationIdRef.current = conversation.id;
            setCompanionMessageCutoffTs(nextCutoffTs);
            convId = conversation.id;
            convRoomId = conversation.roomId;
          } catch {
            return;
          }
        }

        client.sendWsMessage({
          type: "active-conversation",
          conversationId: convId,
        });

        // Eagerly rename "New Chat" using a snippet of the first message
        const activeConv = conversationsRef.current.find(
          (c) => c.id === convId,
        );
        convRoomId = await resolveConversationRoomId(convId, convRoomId);
        if (
          activeConv &&
          (!activeConv.title ||
            activeConv.title === "New Chat" ||
            activeConv.title === "companion.newChat" ||
            activeConv.title === "conversations.newChatTitle")
        ) {
          const fallbackTitle =
            trimmed.length > 15 ? `${trimmed.slice(0, 15)}...` : trimmed;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId ? { ...c, title: fallbackTitle } : c,
            ),
          );
        }

        const now = Date.now();
        const userMsgId = `temp-action-${now}`;
        const assistantMsgId = `temp-action-resp-${now}`;

        setCompanionMessageCutoffTs(now);
        setConversationMessages((prev: ConversationMessage[]) => [
          ...prev,
          { id: userMsgId, role: "user", text: trimmed, timestamp: now },
          { id: assistantMsgId, role: "assistant", text: "", timestamp: now },
        ]);
        setChatSending(true);
        setChatFirstTokenReceived(false);

        controller = new AbortController();
        chatAbortRef.current = controller;
        abortServerTurn = () => {
          abortServerConversationTurn(convRoomId, "ui-chat-abort");
        };
        controller.signal.addEventListener("abort", abortServerTurn, {
          once: true,
        });
        activeChatTurnRef.current = {
          controller,
          roomId: convRoomId,
          abortServerTurn,
        };
        let streamedAssistantText = "";

        try {
          const data = await client.sendConversationMessageStream(
            convId,
            trimmed,
            (token, accumulatedText) => {
              const nextText =
                typeof accumulatedText === "string"
                  ? accumulatedText
                  : mergeStreamingText(streamedAssistantText, token);
              if (nextText === streamedAssistantText) return;
              streamedAssistantText = nextText;
              setChatFirstTokenReceived(true);
              // Coalesce tokens into at most one commit per frame; flushed synchronously
              // below before any terminal modification.
              scheduleStreamingText(assistantMsgId, nextText);
            },
            "DM",
            controller.signal,
            undefined,
            buildChatViewMetadata(tab),
          );

          // Commit any token parked by the throttle before the terminal
          // drop/complete/fail/interrupt — no streamed tokens may be lost.
          flushStreamingText();

          if (!data.text.trim()) {
            if (data.failureKind) {
              // Empty reply but the server flagged a failure class — surface the
              // gate UI instead of silently dropping the turn (the failure
              // branch below is an `else if`, unreachable once the text is
              // empty). Mirrors the non-terminal handler above.
              applyStreamingTextModification(setConversationMessages, {
                messageId: assistantMsgId,
                mode: "fail",
                failureKind: data.failureKind,
              });
            } else {
              applyStreamingTextModification(setConversationMessages, {
                messageId: assistantMsgId,
                mode: "drop",
              });
            }
          } else if (
            shouldApplyFinalStreamText(streamedAssistantText, data.text)
          ) {
            applyStreamingTextModification(setConversationMessages, {
              messageId: assistantMsgId,
              mode: "complete",
              fullText: data.text,
              ...(data.failureKind ? { failureKind: data.failureKind } : {}),
            });
          } else if (data.failureKind) {
            applyStreamingTextModification(setConversationMessages, {
              messageId: assistantMsgId,
              mode: "fail",
              failureKind: data.failureKind,
            });
          }

          // Snapshot a stopped/dropped partial before the reload below so it can
          // survive a full-replace the server's copy lacks (see runQueuedChatSend).
          const interruptedPartial =
            !data.completed && streamedAssistantText.trim()
              ? data.text.trim() || streamedAssistantText
              : null;
          if (interruptedPartial) {
            applyStreamingTextModification(setConversationMessages, {
              messageId: assistantMsgId,
              mode: "interrupt",
            });
          }

          // Keep the visible thread authoritative when the server stores
          // additional action-generated messages during a successful send.
          if (activeConversationIdRef.current === convId) {
            await loadConversationMessages(convId);
            if (interruptedPartial) {
              reattachInterruptedPartial(interruptedPartial);
            }
            // The reload full-replaces the thread; when the server never
            // persisted this turn (agent warm-up), re-attach the user's
            // bubble instead of letting it silently vanish (#11670).
            restoreEvictedUserTurn({
              userMsgId,
              assistantMsgId,
              text: trimmed,
              timestamp: now,
            });
          }

          void loadConversations();
          if (elizaCloudEnabled || elizaCloudConnected) {
            void pollCloudCredits();
          }
        } catch (err) {
          // Commit any throttled-but-uncommitted token first so an abort/error
          // never drops a placeholder the user already saw fill with text.
          flushStreamingText();
          const abortError = err as Error;
          if (abortError.name === "AbortError" || controller?.signal.aborted) {
            dropEmptyAssistantPlaceholder(assistantMsgId);
            return;
          }
          // Surface a status-specific notice so an inbox/connector send that
          // 5xxs, times out, or auth-fails is never silent dead air — the
          // main-chat send path already does this; this one did not (#10231).
          setActionNotice(buildSendFailureNotice(err), "error", 8_000);
          await loadConversationMessages(convId);
          // The reconcile evicts a turn the server never persisted (e.g. the
          // 503 warm-up gate) — restore it with a retryable failed turn
          // (#11670).
          if (activeConversationIdRef.current === convId) {
            restoreEvictedUserTurn({
              userMsgId,
              assistantMsgId,
              text: trimmed,
              timestamp: now,
            });
          }
        } finally {
          // Belt-and-braces: cancel any frame still pending (idempotent).
          flushStreamingText();
          if (chatAbortRef.current === controller) {
            chatAbortRef.current = null;
          }
          if (activeChatTurnRef.current?.controller === controller) {
            activeChatTurnRef.current = null;
          }
          if (chatSendNonceRef.current === sendNonce) {
            chatSendBusyRef.current = false;
            setChatSending(false);
            setChatFirstTokenReceived(false);
            if (chatSendQueueRef.current.length > 0) {
              void flushQueuedChatSends();
            }
          }
        }
      } finally {
        if (controller && abortServerTurn) {
          controller.signal.removeEventListener("abort", abortServerTurn);
        }
        if (controller == null && chatSendNonceRef.current === sendNonce) {
          chatSendBusyRef.current = false;
          if (chatSendQueueRef.current.length > 0) {
            void flushQueuedChatSends();
          }
        }
      }
    },
    [
      activeConversationId,
      chatSendQueueRef,
      elizaCloudEnabled,
      elizaCloudConnected,
      flushQueuedChatSends,
      loadConversationMessages,
      loadConversations,
      pollCloudCredits,
      restoreEvictedUserTurn,
      tab,
      uiLanguage,
      scheduleStreamingText,
      flushStreamingText,
    ],
  );

  const handleChatStop = useCallback(() => {
    interruptActiveChatPipeline();

    // Also stop any active PTY sessions — the user wants everything to halt.
    // Read from the ref so this callback stays stable even as ptySessions polls.
    for (const session of ptySessionsRef.current) {
      client.stopCodingAgent(session.sessionId).catch(() => {});
    }
    // ptySessionsRef is a stable ref object — only include the ref itself, not .current
  }, [interruptActiveChatPipeline, ptySessionsRef]);

  const handleChatRetry = useCallback(
    async (assistantMsgId: string) => {
      const currentMessages = conversationMessagesRef.current;
      // Find the failed/interrupted assistant message + its preceding user turn.
      const assistantIdx = currentMessages.findIndex(
        (m) => m.id === assistantMsgId && m.role === "assistant",
      );
      if (assistantIdx < 0) return;
      let userIdx = -1;
      for (let i = assistantIdx - 1; i >= 0; i--) {
        if (currentMessages[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      const userMsg = currentMessages[userIdx];
      const retryText = userMsg.text;
      if (!retryText) return;

      const convId = activeConversationIdRef.current;
      const canTruncate =
        Boolean(convId) &&
        userMsg.source !== "local_command" &&
        !userMsg.id.startsWith("temp-");

      // Preferred path: re-run the turn IN PLACE. Truncate from the user message
      // (inclusive) so [Q, fail] is removed server-side, then resend Q — exactly
      // like handleChatEdit. The old behaviour only dropped the assistant bubble
      // in memory and resent, producing a duplicate [Q, fail, Q-dup, new] turn.
      if (canTruncate && convId) {
        interruptActiveChatPipeline();
        const preservedMessages = currentMessages.slice(0, userIdx);
        conversationMessagesRef.current = preservedMessages;
        setConversationMessages(preservedMessages);
        try {
          await client.truncateConversationMessages(convId, userMsg.id, {
            inclusive: true,
          });
          await sendChatText(retryText, { conversationId: convId });
        } catch (err) {
          await loadConversationMessages(convId);
          setActionNotice(
            `Failed to retry message: ${err instanceof Error ? err.message : "network error"}`,
            "error",
            4200,
          );
        }
        return;
      }

      // Fallback (no conversation id yet, optimistic/local user turn): drop the
      // failed assistant bubble — and the optimistic (temp-) user turn it
      // retried, which the resend re-renders as a fresh optimistic bubble, so
      // the thread doesn't show the message twice while the retry streams.
      setConversationMessages((prev) =>
        prev.filter(
          (m) =>
            m.id !== assistantMsgId &&
            !(m.id === userMsg.id && m.id.startsWith("temp-")),
        ),
      );
      void sendChatText(retryText);
    },
    [
      sendChatText,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
      interruptActiveChatPipeline,
      loadConversationMessages,
      setActionNotice,
    ],
  );

  const handleChatEdit = useCallback(
    async (messageId: string, text: string): Promise<boolean> => {
      const convId = activeConversationIdRef.current;
      const nextText = text.trim();
      if (!convId || !nextText) {
        return false;
      }

      let currentMessages = conversationMessagesRef.current;
      let messageIndex = currentMessages.findIndex(
        (message) => message.id === messageId && message.role === "user",
      );
      if (messageIndex < 0) {
        const loaded = await loadConversationMessages(convId);
        if (!loaded.ok) {
          return false;
        }
        currentMessages = conversationMessagesRef.current;
        messageIndex = currentMessages.findIndex(
          (message) => message.id === messageId && message.role === "user",
        );
      }
      if (messageIndex < 0) {
        return false;
      }

      const targetMessage = currentMessages[messageIndex];
      if (
        targetMessage.source === "local_command" ||
        targetMessage.id.startsWith("temp-")
      ) {
        return false;
      }

      interruptActiveChatPipeline();
      setChatInput("");

      const preservedMessages = currentMessages.slice(0, messageIndex);
      conversationMessagesRef.current = preservedMessages;
      setConversationMessages(preservedMessages);

      try {
        await client.truncateConversationMessages(convId, messageId, {
          inclusive: true,
        });
        await sendChatText(nextText, { conversationId: convId });
        return true;
      } catch (err) {
        await loadConversationMessages(convId);
        setActionNotice(
          `Failed to edit message: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
        return false;
      }
    },
    [
      loadConversationMessages,
      sendChatText,
      setActionNotice,
      activeConversationIdRef.current,
      conversationMessagesRef,
      interruptActiveChatPipeline,
      setChatInput,
      setConversationMessages,
    ],
  );

  const handleChatClear = useCallback(async () => {
    const convId = activeConversationId;
    if (!convId) {
      setActionNotice("No active conversation to clear.", "info", 2200);
      return;
    }
    interruptActiveChatPipeline();
    try {
      await client.deleteConversation(convId);
      setActiveConversationId(null);
      activeConversationIdRef.current = null;
      setConversationMessages([]);
      setUnreadConversations((prev) => {
        const next = new Set(prev);
        next.delete(convId);
        return next;
      });
      await loadConversations();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        setActiveConversationId(null);
        activeConversationIdRef.current = null;
        setConversationMessages([]);
        setUnreadConversations((prev) => {
          const next = new Set(prev);
          next.delete(convId);
          return next;
        });
        await loadConversations();
        setActionNotice("Conversation was already cleared.", "info", 2600);
        return;
      }
      setActionNotice(
        `Failed to clear conversation: ${err instanceof Error ? err.message : "network error"}`,
        "error",
        4200,
      );
    }
  }, [
    activeConversationId,
    interruptActiveChatPipeline,
    loadConversations,
    setActionNotice,
    activeConversationIdRef,
    setActiveConversationId,
    setConversationMessages,
    setUnreadConversations,
  ]);

  return {
    chatSendQueueRef,
    interruptActiveChatPipeline,
    appendLocalCommandTurn,
    tryHandlePrefixedChatCommand,
    sendChatText,
    handleChatSend,
    sendActionMessage,
    handleChatStop,
    handleChatRetry,
    handleChatEdit,
    handleChatClear,
  };
}
