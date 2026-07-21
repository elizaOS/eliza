/**
 * Chat send callbacks — message sending and streaming operations.
 *
 * Extracted from useChatCallbacks.ts. Handles all message sending,
 * streaming, stop, retry, edit, clear, and queue management.
 */

import { MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { asRecord } from "@elizaos/shared";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type { Conversation, CustomActionDef } from "../api";
import {
  type ChatActionResultSummary,
  type ChatToolCallEvent,
  type ChatTurnStatus,
  type CodingAgentSession,
  type ConversationChannelType,
  type ConversationMessage,
  client,
  type ImageAttachment,
  type MessageAttachmentContentType,
} from "../api";
import { isLimitedCloudAgentApiBase } from "../api/app-shell-capabilities";
import {
  generateChatClientMessageId,
  isStreamGenerationError,
} from "../api/client-base";
import {
  expandSavedCustomCommand,
  loadSavedCustomCommands,
  normalizeSlashCommandName,
} from "../chat";
import { dispatchWorkflowActionHandoff } from "../components/pages/workflow-action-handoff";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
} from "../events";
import {
  publishNativeAgentText,
  publishNativeToolState,
} from "../native-transcript/chat-event-adapter";
import { publishNativeTranscriptEvent } from "../native-transcript/transport";
import type { Tab } from "../navigation";
import { directCloudSharedAgentIdFromBase } from "../utils/cloud-agent-base";
import {
  dispatchViewActionHandoff,
  dispatchViewActionHandoffDirect,
  findViewActionHandoff,
} from "../view-action-handoff";
import type { ChatReplyTarget } from "./ChatComposerContext.hooks";
import { clearChatDraft } from "./ChatComposerContext.hooks";
import { isConversationRecord } from "./chat-conversation-guards";
import {
  buildSendFailureNotice,
  getSendValidationFailureMessage,
  resolveAbortRoomId,
  sentUserTurnPresent,
  UNDELIVERED_TURN_NOTICE,
} from "./chat-send-failures";
import { buildChatViewMetadata } from "./chat-view-routing";
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
import {
  clearPendingChatTurn,
  persistPendingChatTurn,
} from "./pending-chat-turns";
import { streamingRenderDelayMs } from "./streaming-render-cadence";

// ── Types ────────────────────────────────────────────────────────────

type ConversationStreamResult = Awaited<
  ReturnType<typeof client.sendConversationMessageStream>
>;

interface ActiveChatTurn {
  controller: AbortController;
  roomId: string | null;
  abortServerTurn: (() => void) | null;
}

export {
  buildSendFailureNotice,
  getSendValidationFailureMessage,
  resolveAbortRoomId,
  UNDELIVERED_TURN_NOTICE,
} from "./chat-send-failures";

async function handoffCompletedAction(
  actionResults: ChatActionResultSummary[] | undefined,
  showFailure: (message: string) => void,
): Promise<void> {
  if (findViewActionHandoff(actionResults)) {
    // Shared/limited cloud agents (Tier-0) serve NO `/api/views/current`
    // endpoint, so the verify-then-dispatch handoff would throw on the missing
    // route and the navigation would never fire (#F5-ACTIONS). The shared
    // runtime already resolved the target deterministically and stamped it into
    // the summary, so trust it and dispatch the navigate event directly — no
    // server round-trip.
    if (isLimitedCloudAgentApiBase(client.getBaseUrl())) {
      try {
        dispatchViewActionHandoffDirect(actionResults);
      } catch (err) {
        logger.warn(
          { err },
          "[useChatSend] shared-agent VIEWS handoff could not reach the renderer",
        );
        showFailure(
          "The agent chose a view, but the app couldn't open it. Try opening the view again.",
        );
      }
      return;
    }
    try {
      await dispatchViewActionHandoff(actionResults);
    } catch (err) {
      // error-policy:J4 the chat turn succeeded, so preserve it while surfacing a
      // distinct navigation failure instead of fabricating an opened view.
      logger.warn(
        { err },
        "[useChatSend] completed VIEWS action could not reach the renderer",
      );
      showFailure(
        "The agent chose a view, but the app couldn't open it. Try opening the view again.",
      );
    }
    return;
  }
  dispatchWorkflowActionHandoff(actionResults);
}

// Sentinel for the streaming buffer's `pendingStatus`: "no status update
// parked", distinct from a parked `null` (an explicit clear-the-status commit).
// Module scope (not per-render) so the flush callbacks stay referentially
// stable across renders.
const NO_PENDING_STATUS = Symbol("no-pending-status");

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

function abortServerConversationTurn(
  roomId: string | null | undefined,
  reason: string,
): void {
  if (!roomId) return;
  // error-policy:J6 best-effort abort signal for a turn the user already
  // stopped locally; the server also ends the turn when the SSE closes.
  void client.abortConversationTurn(roomId, reason).catch((err) => {
    logger.warn(
      `[useChatSend] abortConversationTurn(${roomId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

export interface QueuedChatSend {
  rawInput: string;
  channelType: ConversationChannelType;
  conversationId?: string | null;
  images?: ImageAttachment[];
  metadata?: Record<string, unknown>;
  /** Stable idempotency key for the initial request and route-level recovery. */
  clientMessageId?: string;
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
  setChatReplyTarget: (v: ChatReplyTarget | null) => void;
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
  chatReplyTargetRef: MutableRefObject<ChatReplyTarget | null>;
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

export async function createConversationForFirstSend(
  chatClient: Pick<typeof client, "createConversation" | "getBaseUrl">,
  lang: string,
  title?: string,
): Promise<{ conversation: Conversation }> {
  const sharedAgentId = directCloudSharedAgentIdFromBase(
    chatClient.getBaseUrl(),
  );
  if (sharedAgentId) {
    // The shared-agent server POST handler ignores the request body, so the
    // title cannot round-trip; synthesize the canonical record locally and
    // skip the redundant cold Worker/Hyperdrive create entirely. The optional
    // `title` only feeds the real REST fallback below.
    const createdAt = new Date().toISOString();
    return {
      conversation: {
        id: sharedAgentId,
        title: "Chat",
        roomId: sharedAgentId,
        createdAt,
        updatedAt: createdAt,
      },
    };
  }
  return chatClient.createConversation(title, { lang });
}

export async function prewarmSharedChatScope(
  chatClient: Pick<typeof client, "getBaseUrl" | "getStatus">,
): Promise<void> {
  if (!directCloudSharedAgentIdFromBase(chatClient.getBaseUrl())) return;
  // Selecting a shared Cloud agent and mounting its composer is a strong signal
  // that a turn is imminent. Warm the exact authenticated scope gate before the
  // user presses Send, so API-key validation, user/org hydration, and agent
  // resolution do not all land on the click-to-first-token critical path.
  await chatClient.getStatus();
}

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
    setChatReplyTarget,
    setActionNotice,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef,
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
  // ElizaClient owns a mutable base outside React state. Snapshot it each render
  // so selecting another agent retriggers the prewarm effect.
  const chatScopePrewarmBase = client.getBaseUrl();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the mutable client base snapshot is the intentional external dependency.
  useEffect(() => {
    void prewarmSharedChatScope(client).catch((error) => {
      // Best-effort only. Send still runs the unchanged authoritative auth gate,
      // so a prewarm outage must not disable or alter normal error semantics.
      logger.debug(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "[chat] shared scope prewarm failed",
      );
    });
  }, [chatScopePrewarmBase]);

  // A lifecycle abort is different from an explicit Stop. During teardown the
  // new page owns recovery, so the durable pending-turn receipt must survive
  // the abort/finally microtask. Explicit stops and all other terminal paths
  // still clear it normally.
  const unmountingRef = useRef(false);

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

  // Streaming-paint coalescer.
  // The SSE stream fires three per-event callbacks that each trigger a state
  // commit: `onToken` (cumulative text, often >60/sec on a fast model),
  // `onStatus` (live turn phase), and `onToolEvent` (inline tool-call steps).
  // A microtask merges callbacks decoded from one transport event, but a fast
  // model still delivers separate events faster than the full chat overlay can
  // render them. Park cumulative snapshots and paint the first one immediately,
  // then at a bounded cadence. Terminal/abort paths synchronously flush the
  // latest snapshot, so throttling cannot lose text. A timeout is the delivery
  // clock rather than rAF because hidden/resource-constrained tabs may defer
  // animation frames for seconds.
  //
  // `pendingStatus` uses the NO_PENDING_STATUS sentinel = "no status update
  // parked", distinct from a parked `null` (an explicit clear-the-status
  // commit).
  const streamingFlushRef = useRef<{
    conversationId: string | null;
    messageId: string;
    pendingText: string | null;
    pendingStatus: ChatTurnStatus | null | typeof NO_PENDING_STATUS;
    pendingToolEvents: ChatToolCallEvent[];
    flushScheduled: boolean;
    flushGeneration: number;
    flushTimer: ReturnType<typeof setTimeout> | null;
    lastFlushAtMs: number | null;
  }>({
    conversationId: null,
    messageId: "",
    pendingText: null,
    pendingStatus: NO_PENDING_STATUS,
    pendingToolEvents: [],
    flushScheduled: false,
    flushGeneration: 0,
    flushTimer: null,
    lastFlushAtMs: null,
  });

  const isConversationCommitActive = useCallback(
    (conversationId: string | null): boolean =>
      activeConversationIdRef.current === conversationId,
    [activeConversationIdRef],
  );

  const setConversationMessagesForConversation = useCallback(
    (
      conversationId: string | null,
      value:
        | ConversationMessage[]
        | ((prev: ConversationMessage[]) => ConversationMessage[]),
    ) => {
      if (!isConversationCommitActive(conversationId)) return;
      setConversationMessages(value);
    },
    [isConversationCommitActive, setConversationMessages],
  );

  const applyStreamingModificationForConversation = useCallback(
    (
      conversationId: string | null,
      modification: Parameters<typeof applyStreamingTextModification>[1],
    ) => {
      if (!isConversationCommitActive(conversationId)) return;
      applyStreamingTextModification(setConversationMessages, modification);
    },
    [isConversationCommitActive, setConversationMessages],
  );

  const reconcileTerminalStream = useCallback(
    (
      conversationId: string,
      assistantMessageId: string,
      streamedAssistantText: string,
      data: ConversationStreamResult,
      options: {
        includeReasoning: boolean;
        includeAccountConnect: boolean;
      },
    ): string | null => {
      if (data.transcriptVisibility === "internal") {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "drop",
        });
        return null;
      }

      if (!data.text.trim()) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          ...(data.failureKind
            ? { mode: "fail", failureKind: data.failureKind }
            : { mode: "drop" }),
        });
      } else if (
        shouldApplyFinalStreamText(streamedAssistantText, data.text) ||
        (options.includeReasoning && data.reasoning) ||
        data.messageId
      ) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "complete",
          fullText: data.text,
          ...(data.failureKind ? { failureKind: data.failureKind } : {}),
          ...(options.includeAccountConnect && data.accountConnect
            ? { accountConnect: data.accountConnect }
            : {}),
          ...(options.includeReasoning && data.reasoning
            ? { reasoning: data.reasoning }
            : {}),
          ...(data.messageId ? { persistedMessageId: data.messageId } : {}),
        });
      } else if (data.failureKind) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "fail",
          failureKind: data.failureKind,
        });
      } else if (options.includeAccountConnect && data.accountConnect) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "complete",
          fullText: data.text,
          accountConnect: data.accountConnect,
          ...(data.messageId ? { persistedMessageId: data.messageId } : {}),
        });
      }

      const interruptedPartial =
        !data.completed && streamedAssistantText.trim()
          ? data.text.trim() || streamedAssistantText
          : null;
      if (interruptedPartial) {
        applyStreamingModificationForConversation(conversationId, {
          messageId: assistantMessageId,
          mode: "interrupt",
        });
      }
      return interruptedPartial;
    },
    [applyStreamingModificationForConversation],
  );

  const setServerTurnStatusForConversation = useCallback(
    (conversationId: string | null, status: ChatTurnStatus | null) => {
      if (!isConversationCommitActive(conversationId)) return;
      setServerTurnStatus(status);
    },
    [isConversationCommitActive, setServerTurnStatus],
  );

  // Commit whatever text/status/tool events are parked for the in-flight turn in
  // one pass, then clear the pending slots. Order matters: tool events merge
  // onto the same turn as the text, and the status is a sibling indicator — all
  // three settle together so the commit reflects one coherent stream state.
  // Safe to call when nothing is pending (no-op).
  const commitStreamingBuffer = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (!isConversationCommitActive(buffer.conversationId)) {
      buffer.pendingText = null;
      buffer.pendingToolEvents = [];
      buffer.pendingStatus = NO_PENDING_STATUS;
      return;
    }
    let committed = false;
    if (buffer.pendingText !== null) {
      const fullText = buffer.pendingText;
      buffer.pendingText = null;
      applyStreamingTextModification(setConversationMessages, {
        messageId: buffer.messageId,
        mode: "replace",
        fullText,
      });
      committed = true;
    }
    if (buffer.pendingToolEvents.length > 0) {
      const toolEvents = buffer.pendingToolEvents;
      buffer.pendingToolEvents = [];
      for (const event of toolEvents) {
        applyStreamingTextModification(setConversationMessages, {
          messageId: buffer.messageId,
          mode: "tool",
          event,
        });
      }
      committed = true;
    }
    if (buffer.pendingStatus !== NO_PENDING_STATUS) {
      const status = buffer.pendingStatus;
      buffer.pendingStatus = NO_PENDING_STATUS;
      setServerTurnStatus(status);
      committed = true;
    }
    if (committed) buffer.lastFlushAtMs = performance.now();
  }, [
    isConversationCommitActive,
    setConversationMessages,
    setServerTurnStatus,
  ]);

  // Apply whatever streaming state is parked for the in-flight turn NOW and
  // invalidate its pending microtask/timer. Called before every terminal/abort
  // transition so no token, tool row, or status is lost.
  const flushStreamingText = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (buffer.flushScheduled) {
      buffer.flushGeneration += 1;
      buffer.flushScheduled = false;
    }
    if (buffer.flushTimer !== null) {
      clearTimeout(buffer.flushTimer);
      buffer.flushTimer = null;
    }
    commitStreamingBuffer();
  }, [commitStreamingBuffer]);

  // Reset the buffer to a fresh turn when `messageId` changes, dropping any
  // stale parked state (text/status/tool) from the prior turn. Runs BEFORE a
  // scheduler parks its value, so the reset never clobbers the value just set.
  const startStreamingTurn = useCallback(
    (conversationId: string, messageId: string) => {
      const buffer = streamingFlushRef.current;
      if (
        buffer.conversationId === conversationId &&
        buffer.messageId === messageId
      )
        return;
      if (buffer.flushScheduled) buffer.flushGeneration += 1;
      if (buffer.flushTimer !== null) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      buffer.conversationId = conversationId;
      buffer.messageId = messageId;
      buffer.pendingText = null;
      buffer.pendingStatus = NO_PENDING_STATUS;
      buffer.pendingToolEvents = [];
      buffer.flushScheduled = false;
      buffer.lastFlushAtMs = null;
    },
    [],
  );

  // The first snapshot paints in a microtask; later snapshots within the
  // cadence window share one trailing timer and overwrite the cumulative text.
  const ensureStreamingFlush = useCallback(() => {
    const buffer = streamingFlushRef.current;
    if (buffer.flushScheduled) return;
    buffer.flushScheduled = true;
    const generation = buffer.flushGeneration;
    const commitScheduled = () => {
      if (buffer.flushGeneration !== generation) return;
      buffer.flushTimer = null;
      buffer.flushScheduled = false;
      commitStreamingBuffer();
    };
    const delayMs = streamingRenderDelayMs(
      buffer.lastFlushAtMs,
      performance.now(),
    );
    if (delayMs === 0) {
      queueMicrotask(commitScheduled);
      return;
    }
    buffer.flushTimer = setTimeout(commitScheduled, delayMs);
  }, [commitStreamingBuffer]);

  // Park the latest cumulative text for `messageId`. Synchronous callbacks from
  // one decoded SSE batch overwrite the parked value and commit together.
  const scheduleStreamingText = useCallback(
    (conversationId: string, messageId: string, fullText: string) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingText = fullText;
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );

  // Park a live turn-status phase for `messageId`; the latest value wins within
  // one synchronous transport burst (superseded phases are never rendered).
  // Coalesced with text/tool events from that burst (#8813).
  const scheduleServerTurnStatus = useCallback(
    (
      conversationId: string,
      messageId: string,
      status: ChatTurnStatus | null,
    ) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingStatus = status;
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );

  // Park one inline tool-call step for `messageId`. Unlike text/status these
  // ACCUMULATE within a transport burst — each step (call → result/error) is a distinct
  // merge onto the turn's `toolEvents`, so none may be dropped (#13535).
  const scheduleToolEvent = useCallback(
    (conversationId: string, messageId: string, event: ChatToolCallEvent) => {
      startStreamingTurn(conversationId, messageId);
      streamingFlushRef.current.pendingToolEvents.push(event);
      ensureStreamingFlush();
    },
    [startStreamingTurn, ensureStreamingFlush],
  );

  // Invalidate any queued flush on unmount so it cannot commit into a torn-down
  // tree.
  useEffect(() => {
    const buffer = streamingFlushRef.current;
    return () => {
      buffer.flushGeneration += 1;
      buffer.flushScheduled = false;
      if (buffer.flushTimer !== null) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      buffer.pendingText = null;
      buffer.conversationId = null;
      buffer.pendingStatus = NO_PENDING_STATUS;
      buffer.pendingToolEvents = [];
    };
  }, []);

  useEffect(() => {
    return () => {
      unmountingRef.current = true;
      const activeTurn = activeChatTurnRef.current;
      if (activeTurn?.abortServerTurn) {
        activeTurn.controller.signal.removeEventListener(
          "abort",
          activeTurn.abortServerTurn,
        );
      }
      activeTurn?.controller.abort();
      chatAbortRef.current?.abort();
      activeChatTurnRef.current = null;
      chatAbortRef.current = null;
      chatSendBusyRef.current = false;
      chatSendQueueRef.current.splice(0);
    };
  }, [chatAbortRef, chatSendBusyRef]);

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
    // and invalidate the pending scheduled flush so it can't fire after stop.
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
        } catch (err) {
          // error-policy:J4 designed degrade: a broken custom-action catalog
          // must not block the send — the slash text falls through to normal
          // chat routing, and the failure is logged so it stays observable.
          logger.warn(
            `[useChatSend] listCustomActions failed; falling back to normal slash routing: ${err instanceof Error ? err.message : String(err)}`,
          );
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
    (conversationId: string | null, assistantMsgId: string) => {
      setConversationMessagesForConversation(conversationId, (prev) =>
        prev.filter(
          (message) => !(message.id === assistantMsgId && !message.text.trim()),
        ),
      );
    },
    [setConversationMessagesForConversation],
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
    (conversationId: string | null, partialText: string) => {
      const text = partialText.trim();
      if (!text) return;
      setConversationMessagesForConversation(conversationId, (prev) => {
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
    [setConversationMessagesForConversation],
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
    (
      conversationId: string | null,
      turn: {
        userMsgId: string;
        assistantMsgId: string;
        text: string;
        timestamp: number;
        attachments?: ConversationMessage["attachments"];
      },
    ) => {
      const sentText = turn.text.trim();
      if (!sentText) return;
      setConversationMessagesForConversation(conversationId, (prev) => {
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
    [setConversationMessagesForConversation],
  );

  const runQueuedChatSend = useCallback(
    async (turn: Omit<QueuedChatSend, "resolve" | "reject">) => {
      const hasAttachedImages = Boolean(turn.images?.length);
      const rawText = turn.rawInput.trim();
      if (!rawText && !hasAttachedImages) return;

      const channelType = turn.channelType;
      const imagesToSend = turn.images;
      // One idempotency key spans the initial request and route-level recovery.
      const clientMessageId =
        turn.clientMessageId ?? generateChatClientMessageId();
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

      const now = Date.now();
      const userMsgId = `temp-${clientMessageId}`;
      const assistantMsgId = `temp-resp-${clientMessageId}`;

      if (channelType === "VOICE_DM") {
        publishNativeTranscriptEvent({
          type: "stt.final",
          turnId: clientMessageId,
          text,
          at: now,
        });
      }

      // Paint the accepted turn before conversation creation / room discovery.
      // Those calls can take seconds on a cold cloud agent; clearing the composer
      // first and waiting to add this row made the user's message look lost.
      const optimisticAttachments = imagesToSend?.length
        ? imagesToSend.map((img, i) => ({
            id: `${userMsgId}-img-${i}`,
            url: `data:${img.mimeType};base64,${img.data}`,
            contentType: optimisticAttachmentKind(img.mimeType),
            ...(img.name ? { title: img.name } : {}),
            mimeType: img.mimeType,
            source: MESSAGE_SOURCE_CLIENT_CHAT,
            ...(img.transcriptId ? { transcriptId: img.transcriptId } : {}),
            ...(img.thumbnail
              ? {
                  thumbnailUrl: `data:${img.thumbnail.mimeType};base64,${img.thumbnail.data}`,
                }
              : {}),
          }))
        : undefined;
      const optimisticUserMessage: ConversationMessage = {
        id: userMsgId,
        clientRenderId: userMsgId,
        role: "user",
        text,
        timestamp: now,
        ...(optimisticAttachments
          ? { attachments: optimisticAttachments }
          : {}),
      };
      const optimisticAssistantMessage: ConversationMessage = {
        id: assistantMsgId,
        clientRenderId: assistantMsgId,
        role: "assistant",
        text: "",
        timestamp: now,
      };
      const optimisticOwnerConversationId =
        turn.conversationId ?? activeConversationIdRef.current ?? null;
      setCompanionMessageCutoffTs(now);
      setConversationMessagesForConversation(
        optimisticOwnerConversationId,
        (prev: ConversationMessage[]) => {
          const userIndex = prev.findIndex(
            (message) => message.id === userMsgId,
          );
          const assistantIndex = prev.findIndex(
            (message) => message.id === assistantMsgId,
          );
          if (userIndex >= 0) {
            if (assistantIndex >= 0) return prev;
            return [
              ...prev.slice(0, userIndex + 1),
              optimisticAssistantMessage,
              ...prev.slice(userIndex + 1),
            ];
          }
          if (assistantIndex >= 0) {
            return [
              ...prev.slice(0, assistantIndex),
              optimisticUserMessage,
              ...prev.slice(assistantIndex),
            ];
          }
          return [...prev, optimisticUserMessage, optimisticAssistantMessage];
        },
      );
      if (isConversationCommitActive(optimisticOwnerConversationId)) {
        setChatFirstTokenReceived(false);
      }

      let convId: string =
        turn.conversationId ?? activeConversationIdRef.current ?? "";
      if (!convId) {
        try {
          const { conversation: rawConversation } =
            await createConversationForFirstSend(client, uiLanguage);
          if (!isConversationRecord(rawConversation)) {
            throw new Error(
              "Conversation creation returned an invalid payload.",
            );
          }
          const conversation = rawConversation;
          const nextCutoffTs = Date.now();
          setConversations((prev) => [conversation, ...prev]);
          if (
            activeConversationIdRef.current === optimisticOwnerConversationId
          ) {
            setActiveConversationId(conversation.id);
            activeConversationIdRef.current = conversation.id;
          }
          setCompanionMessageCutoffTs(nextCutoffTs);
          convId = conversation.id;
          convRoomId = conversation.roomId;
        } catch {
          // error-policy:J4 surfaced user-facing failure state.
          // First-message conversation creation failed (cold open on weak
          // signal). Remove the local accepted-turn rows and restore the draft:
          // no conversation exists to own or retry this turn yet.
          setConversationMessagesForConversation(
            optimisticOwnerConversationId,
            (prev) =>
              prev.filter(
                (message) =>
                  message.id !== userMsgId && message.id !== assistantMsgId,
              ),
          );
          setChatInput(rawText);
          setActionNotice(
            "Couldn't start the conversation — check your connection and try again. Your message was restored.",
            "error",
            8_000,
          );
          return;
        }
      }

      persistPendingChatTurn({
        conversationId: convId,
        clientMessageId,
        text,
        sentAt: now,
      });

      client.sendWsMessage({
        type: "active-conversation",
        conversationId: convId,
      });

      const activeConv = conversationsRef.current.find((c) => c.id === convId);
      // The room id is used only by the optional abort side-channel. Never hold
      // the primary message POST behind a conversation-list refresh: on Cloud
      // that extra edge/DB round trip can delay request dispatch by 3-4s even
      // though the optimistic bubble already painted. A known room id wins;
      // conversation id is the protocol fallback (and is canonical for shared
      // runtime conversations).
      convRoomId = resolveAbortRoomId(convId, convRoomId, activeConv?.roomId);
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
            if (channelType === "VOICE_DM") {
              publishNativeAgentText({
                messageId: assistantMsgId,
                turnId: clientMessageId,
                text: nextText,
                final: false,
              });
            }
            if (isConversationCommitActive(convId)) {
              setChatFirstTokenReceived(true);
            }
            // Coalesce tokens delivered in one transport burst into a microtask;
            // the parked text is flushed synchronously before terminal changes.
            scheduleStreamingText(convId, assistantMsgId, nextText);
          },
          channelType,
          controller.signal,
          imagesToSend,
          turn.metadata,
          // Live server phase → the rich status indicator. Additive; the reply
          // streams through onToken above regardless. Coalesced into the same
          // transport-burst microtask as text/tool commits and flushed
          // synchronously before any terminal transition.
          (status) => scheduleServerTurnStatus(convId, assistantMsgId, status),
          // Inline tool-call steps → the turn's tool rows (call → result/error),
          // merged by callId so one row flips running → settled (#13535).
          // Coalesced into the current transport burst with the text + status.
          (event) => {
            scheduleToolEvent(convId, assistantMsgId, event);
            if (channelType === "VOICE_DM") {
              publishNativeToolState(event, clientMessageId);
            }
          },
          // Stable idempotency key for this logical turn.
          clientMessageId,
        );

        // Commit any token parked by the throttle before the terminal
        // drop/complete/fail/interrupt — no streamed tokens may be lost.
        flushStreamingText();

        if (channelType === "VOICE_DM") {
          const finalText = data.text || streamedAssistantText;
          if (finalText) {
            publishNativeAgentText({
              messageId: assistantMsgId,
              turnId: clientMessageId,
              text: finalText,
              final: data.completed !== false,
            });
          }
          if (data.failureKind) {
            publishNativeTranscriptEvent({
              type: "error",
              code: data.failureKind,
              retryable: true,
            });
          }
          if (data.completed === false) {
            publishNativeTranscriptEvent({
              type: "cancel",
              scope: "turn",
              turnId: clientMessageId,
              reason: "generation-incomplete",
            });
          }
        }

        if (data.userMessageId) {
          applyStreamingModificationForConversation(convId, {
            messageId: userMsgId,
            mode: "rekey",
            persistedMessageId: data.userMessageId,
          });
        }
        const interruptedPartial = reconcileTerminalStream(
          convId,
          assistantMsgId,
          streamedAssistantText,
          data,
          { includeReasoning: true, includeAccountConnect: true },
        );
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
        // The stream result is the user-visible end of this turn. History
        // reconciliation can continue below, but it must not leave a completed
        // reply looking active. Keep the busy state when another turn is queued.
        setServerTurnStatusForConversation(convId, null);
        if (isConversationCommitActive(convId)) {
          setChatFirstTokenReceived(false);
        }
        if (chatSendQueueRef.current.length === 0) {
          if (isConversationCommitActive(convId)) {
            setChatSending(false);
          }
        }
        await handoffCompletedAction(data.actionResults, (message) => {
          setActionNotice(message, "error", 8_000);
        });

        // Direct replies already carry both committed memory ids, so reloading
        // the whole transcript would add a DB round trip, replace every message
        // object, and race the terminal frame. Action callbacks are the only
        // topology that may commit extra rows outside the streamed bubble.
        if (
          activeConversationIdRef.current === convId &&
          (data.historyRefreshRequired ||
            !data.completed ||
            (!data.messageId && !data.assistantEphemeral) ||
            !data.userMessageId)
        ) {
          await loadConversationMessages(convId);
          // The reload above full-replaces the thread; a stopped reply is often
          // NOT persisted server-side, so re-attach the partial the user watched
          // stream in (no-op / no duplicate when the server kept it).
          if (interruptedPartial) {
            reattachInterruptedPartial(convId, interruptedPartial);
          }
          // Same full-replace hazard for the USER turn: a send during agent
          // warm-up can complete with nothing persisted, and the reload then
          // evicts the user's bubble (#11670). Restore it with a retryable
          // failed turn; no-op when the server persisted it.
          restoreEvictedUserTurn(convId, {
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
              // error-policy:J4 title generation is decorative — the snippet
              // fallback title is already applied; the reload keeps the list
              // fresh either way.
              logger.warn(
                `[useChatSend] conversation title generation failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              void loadConversations();
            });
        } else {
          void loadConversations();
        }

        if (elizaCloudEnabled || elizaCloudConnected) {
          void pollCloudCredits();
        }
        clearPendingChatTurn(convId, clientMessageId);
      } catch (err) {
        // Commit any throttled-but-uncommitted token first so an abort/error
        // never drops a placeholder the user already saw fill with partial text.
        flushStreamingText();
        const abortError = err as Error;
        if (abortError.name === "AbortError" || controller?.signal.aborted) {
          if (channelType === "VOICE_DM") {
            publishNativeTranscriptEvent({
              type: "cancel",
              scope: "turn",
              turnId: clientMessageId,
              reason: "aborted",
            });
          }
          dropEmptyAssistantPlaceholder(convId, assistantMsgId);
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
            applyStreamingModificationForConversation(convId, {
              messageId: assistantMsgId,
              mode: "fail",
              failureKind: err.failureKind,
            });
          } else if (err.accountConnect) {
            applyStreamingModificationForConversation(convId, {
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
              dropEmptyAssistantPlaceholder(convId, assistantMsgId);
              return;
            }
            // Non-cloud base, or a different create failure — the recovery
            // could not produce a conversation to replay into. Drop the empty
            // placeholder and tell the user; a silent return here read as a
            // lost message.
            dropEmptyAssistantPlaceholder(convId, assistantMsgId);
            setActionNotice(buildSendFailureNotice(createErr), "error", 8_000);
            return;
          }

          // Seed ids live above the try so the failure handler below can
          // remove the replay's own placeholder (the original assistant id no
          // longer exists once the thread is re-seeded).
          const replayUserId = `temp-${Date.now()}`;
          const replayAssistantId = `temp-resp-${Date.now()}`;
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
            // Seed unfiltered (like the primary send path) — the empty assistant
            // placeholder must survive so streamed tokens have a target;
            // filterRenderableConversationMessages would drop an empty turn.
            setConversationMessagesForConversation(conversation.id, [
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
                if (isConversationCommitActive(conversation.id)) {
                  setChatFirstTokenReceived(true);
                }
                scheduleStreamingText(
                  conversation.id,
                  replayAssistantId,
                  nextText,
                );
              },
              channelType,
              controller?.signal,
              imagesToSend,
              turn.metadata,
              (serverStatus) =>
                scheduleServerTurnStatus(
                  conversation.id,
                  replayAssistantId,
                  serverStatus,
                ),
              (event) =>
                scheduleToolEvent(conversation.id, replayAssistantId, event),
              // Same idempotency key across the whole logical turn, including
              // the 404 recreate-and-replay recovery.
              clientMessageId,
            );

            await handoffCompletedAction(retryData.actionResults, (message) => {
              setActionNotice(message, "error", 8_000);
            });

            // Commit any throttle-parked token before the terminal modification.
            flushStreamingText();

            reconcileTerminalStream(
              conversation.id,
              replayAssistantId,
              replayStreamedText,
              retryData,
              { includeReasoning: true, includeAccountConnect: true },
            );
          } catch (replayErr) {
            // The re-seed above replaced the whole thread, so the ORIGINAL
            // placeholder id is gone — dropping it was a no-op that left the
            // replay's empty bubble stuck forever and the failure invisible.
            // Clean up the replay placeholder and surface the failure exactly
            // like the primary send path (aborts stay silent by design).
            flushStreamingText();
            dropEmptyAssistantPlaceholder(conversation.id, replayAssistantId);
            if (
              (replayErr as Error).name !== "AbortError" &&
              !controller?.signal.aborted
            ) {
              setActionNotice(
                buildSendFailureNotice(replayErr),
                "error",
                8_000,
              );
            }
          }
        } else {
          // Non-abort, non-404 send failure (network/timeout/5xx/auth/429/4xx).
          // Surface the manual resend affordance immediately. Waiting for a
          // speculative reconnect makes a dead request look like a slow model
          // response and can hide failure for tens of seconds.
          // Drop the empty assistant placeholder but KEEP the user's message,
          // and surface a status-specific notice so a failed turn is never
          // silent dead air.
          dropEmptyAssistantPlaceholder(convId, assistantMsgId);
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
              restoreEvictedUserTurn(convId, {
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
        // Belt-and-braces: invalidate any microtask still pending so it cannot commit a
        // stale snapshot into the next turn (idempotent — every exit path above
        // already flushed).
        flushStreamingText();
        // The turn settled (done / error / abort) — drop the live status so the
        // indicator doesn't linger on a stale phase between turns.
        setServerTurnStatusForConversation(
          convId || optimisticOwnerConversationId,
          null,
        );
        if (controller && abortServerTurn) {
          controller.signal.removeEventListener("abort", abortServerTurn);
        }
        if (chatAbortRef.current === controller) {
          chatAbortRef.current = null;
        }
        if (activeChatTurnRef.current?.controller === controller) {
          activeChatTurnRef.current = null;
        }
        if (convId && !unmountingRef.current) {
          clearPendingChatTurn(convId, clientMessageId);
        }
      }
    },
    [
      appendLocalCommandTurn,
      applyStreamingModificationForConversation,
      reconcileTerminalStream,
      loadConversationMessages,
      loadConversations,
      tryHandlePrefixedChatCommand,
      activeConversationIdRef,
      chatAbortRef,
      conversationMessagesRef.current.filter,
      conversationsRef,
      isConversationCommitActive,
      setActiveConversationId,
      setChatFirstTokenReceived,
      setChatSending,
      setServerTurnStatusForConversation,
      setChatLastUsage,
      setCompanionMessageCutoffTs,
      setConversationMessagesForConversation,
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
      scheduleServerTurnStatus,
      scheduleToolEvent,
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
        clientMessageId?: string;
      },
    ) => {
      const hasAttachedImages = Boolean(options?.images?.length);
      if (!rawInput.trim() && !hasAttachedImages) {
        return;
      }

      // Claim + clear the active reply target here — the single chokepoint every
      // real user turn (composer send + overlay/voice send()) funnels through —
      // so one Reply affordance covers all surfaces and a second send never
      // re-attaches a stale reply. Skip when the caller already stamped a reply
      // (a retry replaying an earlier reply-turn's metadata). The id rides in
      // `metadata.replyToMessageId`; the API boundary lifts it onto
      // `content.inReplyTo`, which drives the REPLY_CONTEXT provider.
      const replyTarget = chatReplyTargetRef.current;
      const metadata =
        replyTarget && !asRecord(options?.metadata)?.replyToMessageId
          ? { ...options?.metadata, replyToMessageId: replyTarget.messageId }
          : options?.metadata;
      if (replyTarget) {
        chatReplyTargetRef.current = null;
        setChatReplyTarget(null);
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
          metadata: buildChatViewMetadata(tab, metadata),
          clientMessageId: options?.clientMessageId,
          resolve,
          reject,
        });
        setChatSending(true);
        void flushQueuedChatSends();
      });
    },
    [flushQueuedChatSends, setChatSending, setChatReplyTarget, tab],
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

      // The reply target (if any) is attached + cleared inside sendChatText, the
      // single chokepoint both this and the overlay's send() funnel through.
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
            // Defer the create the same way the fixed cold-open send path does
            // (runQueuedChatSend -> createConversationForFirstSend): on a shared
            // agent base this synthesizes the canonical record locally and skips
            // the redundant cold Worker/Hyperdrive round trip. The title is only
            // forwarded to the real REST fallback (the shared server ignores it).
            const { conversation: rawConversation } =
              await createConversationForFirstSend(
                client,
                uiLanguage,
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
            // error-policy:J4 surfaced user-facing failure state. An
            // action/inbox send that can't start a conversation must not
            // vanish silently (mirrors the cold-open path in
            // runQueuedChatSend).
            setActionNotice(
              "Couldn't start the conversation — check your connection and try again.",
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

        // Eagerly rename "New Chat" using a snippet of the first message
        const activeConv = conversationsRef.current.find(
          (c) => c.id === convId,
        );
        // Do not block action/inbox sends on a list refresh solely to resolve
        // the abort side-channel room id. See the interactive send path above.
        convRoomId = resolveAbortRoomId(convId, convRoomId, activeConv?.roomId);
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
        setConversationMessagesForConversation(
          convId,
          (prev: ConversationMessage[]) => [
            ...prev,
            { id: userMsgId, role: "user", text: trimmed, timestamp: now },
            { id: assistantMsgId, role: "assistant", text: "", timestamp: now },
          ],
        );
        if (isConversationCommitActive(convId)) {
          setChatSending(true);
          setChatFirstTokenReceived(false);
        }

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
              if (isConversationCommitActive(convId)) {
                setChatFirstTokenReceived(true);
              }
              // Coalesce tokens delivered in one transport burst into a microtask;
              // flush synchronously before terminal changes.
              scheduleStreamingText(convId, assistantMsgId, nextText);
            },
            "DM",
            controller.signal,
            undefined,
            buildChatViewMetadata(tab),
            // No overlay status on the action/DM path (its finally doesn't clear
            // it); still stream inline tool rows onto the turn (#13535),
            // coalesced into the current transport burst with the text.
            undefined,
            (event) => scheduleToolEvent(convId, assistantMsgId, event),
          );

          // Commit any token parked by the throttle before the terminal
          // drop/complete/fail/interrupt — no streamed tokens may be lost.
          flushStreamingText();
          await handoffCompletedAction(data.actionResults, (message) => {
            setActionNotice(message, "error", 8_000);
          });

          const interruptedPartial = reconcileTerminalStream(
            convId,
            assistantMsgId,
            streamedAssistantText,
            data,
            { includeReasoning: false, includeAccountConnect: false },
          );

          // Keep the visible thread authoritative when the server stores
          // additional action-generated messages during a successful send.
          if (activeConversationIdRef.current === convId) {
            await loadConversationMessages(convId);
            if (interruptedPartial) {
              reattachInterruptedPartial(convId, interruptedPartial);
            }
            // The reload full-replaces the thread; when the server never
            // persisted this turn (agent warm-up), re-attach the user's
            // bubble instead of letting it silently vanish (#11670).
            restoreEvictedUserTurn(convId, {
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
            dropEmptyAssistantPlaceholder(convId, assistantMsgId);
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
            restoreEvictedUserTurn(convId, {
              userMsgId,
              assistantMsgId,
              text: trimmed,
              timestamp: now,
            });
          }
        } finally {
          // Belt-and-braces: invalidate any pending scheduled flush (idempotent).
          flushStreamingText();
          if (chatAbortRef.current === controller) {
            chatAbortRef.current = null;
          }
          if (activeChatTurnRef.current?.controller === controller) {
            activeChatTurnRef.current = null;
          }
          if (chatSendNonceRef.current === sendNonce) {
            chatSendBusyRef.current = false;
            if (isConversationCommitActive(convId)) {
              setChatSending(false);
              setChatFirstTokenReceived(false);
            }
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
      applyStreamingModificationForConversation,
      reconcileTerminalStream,
      restoreEvictedUserTurn,
      dropEmptyAssistantPlaceholder,
      reattachInterruptedPartial,
      isConversationCommitActive,
      setConversationMessagesForConversation,
      setChatFirstTokenReceived,
      setChatSending,
      tab,
      uiLanguage,
      scheduleStreamingText,
      scheduleToolEvent,
      flushStreamingText,
    ],
  );

  const handleChatStop = useCallback(() => {
    interruptActiveChatPipeline();

    // Also stop any active PTY sessions — the user wants everything to halt.
    // Read from the ref so this callback stays stable even as ptySessions polls.
    for (const session of ptySessionsRef.current) {
      // error-policy:J6 best-effort bulk stop on user-initiated halt; a session
      // that fails to stop keeps reporting its live status in the PTY panel.
      client.stopCodingAgent(session.sessionId).catch((err) => {
        logger.warn(
          `[useChatSend] stopCodingAgent(${session.sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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

  // Persistently delete a single message (#13533). Optimistically removes the
  // bubble, fires the server DELETE, and re-hydrates from the store on failure
  // so a network/authz error never leaves a locally-hidden-but-still-persisted
  // message. Distinct from the local-only `removeConversationMessage`
  // suggestion dismissal (#8792), which is intentionally server-free.
  const handleChatDelete = useCallback(
    async (messageId: string): Promise<boolean> => {
      const convId = activeConversationIdRef.current;
      if (!convId) return false;

      const currentMessages = conversationMessagesRef.current;
      const target = currentMessages.find((m) => m.id === messageId);
      // An optimistic (temp-) or local command turn has no persisted memory row
      // to delete; drop it locally so the UI stays consistent.
      if (
        !target ||
        target.id.startsWith("temp-") ||
        target.source === "local_command"
      ) {
        const nextMessages = currentMessages.filter((m) => m.id !== messageId);
        conversationMessagesRef.current = nextMessages;
        setConversationMessages(nextMessages);
        return true;
      }

      // Optimistic removal, remembering the prior list for rollback.
      const preserved = currentMessages;
      const nextMessages = currentMessages.filter((m) => m.id !== messageId);
      conversationMessagesRef.current = nextMessages;
      setConversationMessages(nextMessages);

      try {
        await client.deleteConversationMessage(convId, messageId);
        return true;
      } catch (err) {
        // Roll back so the message stays visible — never a silent local-only
        // removal on failure. Only touch state if we're still viewing the
        // conversation we deleted from: a switch mid-delete swapped the ref +
        // setter to another conversation, and restoring this one's snapshot
        // there would leak state across conversations (same guard every send
        // path uses). Reconcile against the CURRENT list — re-add the pre-delete
        // messages while keeping anything that streamed in during the request —
        // rather than overwriting with the stale snapshot, so a reply that
        // arrived mid-delete is not clobbered.
        if (activeConversationIdRef.current === convId) {
          const live = conversationMessagesRef.current;
          const preservedIds = new Set(preserved.map((m) => m.id));
          const restored = [
            ...preserved,
            ...live.filter((m) => !preservedIds.has(m.id)),
          ];
          conversationMessagesRef.current = restored;
          setConversationMessages(restored);
        }
        setActionNotice(
          `Failed to delete message: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
        return false;
      }
    },
    [
      activeConversationIdRef,
      conversationMessagesRef,
      setConversationMessages,
      setActionNotice,
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
    handleChatDelete,
    handleChatClear,
  };
}
