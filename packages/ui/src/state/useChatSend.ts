/**
 * Chat send callbacks — message sending and streaming operations.
 *
 * Extracted from useChatCallbacks.ts. Handles all message sending,
 * streaming, stop, retry, edit, clear, and queue management.
 */

import { asRecord } from "@elizaos/shared";
import { type MutableRefObject, useCallback, useRef } from "react";
import type { Conversation, CustomActionDef } from "../api";
import {
  type CodingAgentSession,
  type ConversationChannelType,
  type ConversationMessage,
  type ConversationMode,
  client,
  type ImageAttachment,
} from "../api";
import {
  expandSavedCustomCommand,
  loadSavedCustomCommands,
  normalizeSlashCommandName,
} from "../chat";
import type { Tab } from "../navigation";
import { isConversationRecord } from "./chat-conversation-guards";
import { clearChatDraft } from "./ChatComposerContext";
import {
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

interface ChatViewRouting {
  view: string;
  primaryContext: string;
  secondaryContexts: string[];
  capabilities: string[];
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

function resolveChatViewRouting(tab: Tab): ChatViewRouting {
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
    case "lifeops":
      return {
        view: "apps",
        primaryContext: "automation",
        secondaryContexts: ["social_posting", "documents"],
        capabilities: ["lifeops", "tasks", "calendar"],
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
  const viewRouting = resolveChatViewRouting(tab);
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
  chatMode: ConversationMode;
  conversations: Conversation[];
  activeConversationId: string | null;
  /** Stable ref whose .current mirrors the latest ptySessions array. */
  ptySessionsRef: MutableRefObject<CodingAgentSession[]>;

  // Setters
  setChatInput: (v: string) => void;
  setChatSending: (v: boolean) => void;
  setChatFirstTokenReceived: (v: boolean) => void;
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
    chatMode,
    conversations,
    activeConversationId,
    ptySessionsRef,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
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

  const resolveQueuedChatSends = useCallback(() => {
    const queued = chatSendQueueRef.current.splice(0);
    for (const turn of queued) {
      turn.resolve();
    }
  }, []);

  const interruptActiveChatPipeline = useCallback(() => {
    resolveQueuedChatSends();
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setChatSending(false);
    setChatFirstTokenReceived(false);
  }, [
    chatAbortRef,
    resolveQueuedChatSends,
    setChatFirstTokenReceived,
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

  const runQueuedChatSend = useCallback(
    async (turn: Omit<QueuedChatSend, "resolve" | "reject">) => {
      const hasAttachedImages = Boolean(turn.images?.length);
      const rawText = turn.rawInput.trim();
      if (!rawText && !hasAttachedImages) return;

      const channelType = turn.channelType;
      const conversationMode: ConversationMode =
        channelType === "VOICE_DM" || channelType === "VOICE_GROUP"
          ? "simple"
          : chatMode;
      const imagesToSend = turn.images;
      let controller: AbortController | null = null;

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
        } catch {
          return;
        }
      }

      client.sendWsMessage({
        type: "active-conversation",
        conversationId: convId,
      });

      const activeConv = conversations.find((c) => c.id === convId);
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

      setCompanionMessageCutoffTs(now);
      setConversationMessages((prev: ConversationMessage[]) => [
        ...prev,
        { id: userMsgId, role: "user", text, timestamp: now },
        { id: assistantMsgId, role: "assistant", text: "", timestamp: now },
      ]);
      setChatFirstTokenReceived(false);

      controller = new AbortController();
      chatAbortRef.current = controller;
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
            setConversationMessages((prev) =>
              prev.map((message) =>
                message.id !== assistantMsgId
                  ? message
                  : message.text === nextText
                    ? message
                    : { ...message, text: nextText },
              ),
            );
          },
          channelType,
          controller.signal,
          imagesToSend,
          conversationMode,
          turn.metadata,
        );

        if (!data.text.trim()) {
          setConversationMessages((prev) =>
            prev.filter((message) => message.id !== assistantMsgId),
          );
        } else if (
          shouldApplyFinalStreamText(streamedAssistantText, data.text)
        ) {
          setConversationMessages((prev) => {
            let changed = false;
            const next = prev.map((message) => {
              if (message.id !== assistantMsgId) return message;
              if (
                message.text === data.text &&
                message.failureKind === data.failureKind
              ) {
                return message;
              }
              changed = true;
              return {
                ...message,
                text: data.text,
                ...(data.failureKind ? { failureKind: data.failureKind } : {}),
              };
            });
            return changed ? next : prev;
          });
        } else if (data.failureKind) {
          // Streaming text already matched but the server flagged a failure
          // class — stamp it on the assistant turn so the renderer can swap
          // in the gate UI (e.g. "Connect a provider").
          setConversationMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMsgId
                ? { ...message, failureKind: data.failureKind }
                : message,
            ),
          );
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

        if (!data.completed && streamedAssistantText.trim()) {
          setConversationMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMsgId
                ? { ...message, interrupted: true }
                : message,
            ),
          );
        }

        // Action callbacks can persist additional assistant turns that are not
        // mirrored by the optimistic streaming placeholder in local state.
        if (activeConversationIdRef.current === convId) {
          await loadConversationMessages(convId);
        }

        const userMessageCount = conversationMessagesRef.current.filter(
          (message) =>
            message.role === "user" && !message.id.startsWith("temp-"),
        ).length;

        if (userMessageCount === 1) {
          void client
            .renameConversation(convId, "", { generate: true })
            .then(() => {
              void loadConversations();
            });
        } else {
          void loadConversations();
        }

        if (elizaCloudEnabled || elizaCloudConnected) {
          void pollCloudCredits();
        }
      } catch (err) {
        const abortError = err as Error;
        if (abortError.name === "AbortError") {
          setConversationMessages((prev) =>
            prev.filter(
              (message) =>
                !(message.id === assistantMsgId && !message.text.trim()),
            ),
          );
          return;
        }

        const status = (err as { status?: number }).status;
        if (status === 404) {
          try {
            const { conversation: rawConversation } =
              await client.createConversation();
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
            client.sendWsMessage({
              type: "active-conversation",
              conversationId: conversation.id,
            });

            const retryData = await client.sendConversationMessage(
              conversation.id,
              text,
              channelType,
              imagesToSend,
              conversationMode,
              turn.metadata,
            );
            setConversationMessages(
              filterRenderableConversationMessages([
                {
                  id: `temp-${Date.now()}`,
                  role: "user",
                  text,
                  timestamp: Date.now(),
                },
                {
                  id: `temp-resp-${Date.now()}`,
                  role: "assistant",
                  text: retryData.text,
                  timestamp: Date.now(),
                  ...(retryData.failureKind
                    ? { failureKind: retryData.failureKind }
                    : {}),
                },
              ]),
            );
          } catch {
            setConversationMessages((prev) =>
              prev.filter(
                (message) =>
                  !(message.id === assistantMsgId && !message.text.trim()),
              ),
            );
          }
        } else {
          await loadConversationMessages(convId);
        }
      } finally {
        if (chatAbortRef.current === controller) {
          chatAbortRef.current = null;
        }
      }
    },
    [
      appendLocalCommandTurn,
      chatMode,
      loadConversationMessages,
      loadConversations,
      tryHandlePrefixedChatCommand,
      activeConversationIdRef,
      chatAbortRef,
      conversationMessagesRef.current.filter,
      conversations.find,
      setActiveConversationId,
      setChatFirstTokenReceived,
      setChatLastUsage,
      setCompanionMessageCutoffTs,
      setConversationMessages,
      setConversations,
      uiLanguage,
      elizaCloudEnabled,
      elizaCloudConnected,
      pollCloudCredits,
    ],
  );

  const flushQueuedChatSends = useCallback(async () => {
    if (chatSendBusyRef.current) return;
    chatSendBusyRef.current = true;
    setChatSending(true);

    try {
      while (chatSendQueueRef.current.length > 0) {
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
          conversationId: options?.conversationId,
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
      const conversationMode: ConversationMode = chatMode;
      let controller: AbortController | null = null;

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
          } catch {
            return;
          }
        }

        client.sendWsMessage({
          type: "active-conversation",
          conversationId: convId,
        });

        // Eagerly rename "New Chat" using a snippet of the first message
        const activeConv = conversations.find((c) => c.id === convId);
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
              setConversationMessages((prev) =>
                prev.map((message) =>
                  message.id !== assistantMsgId
                    ? message
                    : message.text === nextText
                      ? message
                      : { ...message, text: nextText },
                ),
              );
            },
            "DM",
            controller.signal,
            undefined,
            conversationMode,
            buildChatViewMetadata(tab),
          );

          if (!data.text.trim()) {
            setConversationMessages((prev) =>
              prev.filter((message) => message.id !== assistantMsgId),
            );
          } else if (
            shouldApplyFinalStreamText(streamedAssistantText, data.text)
          ) {
            setConversationMessages((prev) => {
              let changed = false;
              const next = prev.map((message) => {
                if (message.id !== assistantMsgId) return message;
                if (
                  message.text === data.text &&
                  message.failureKind === data.failureKind
                ) {
                  return message;
                }
                changed = true;
                return {
                  ...message,
                  text: data.text,
                  ...(data.failureKind
                    ? { failureKind: data.failureKind }
                    : {}),
                };
              });
              return changed ? next : prev;
            });
          } else if (data.failureKind) {
            setConversationMessages((prev) =>
              prev.map((message) =>
                message.id === assistantMsgId
                  ? { ...message, failureKind: data.failureKind }
                  : message,
              ),
            );
          }

          if (!data.completed && streamedAssistantText.trim()) {
            setConversationMessages((prev) =>
              prev.map((message) =>
                message.id === assistantMsgId
                  ? { ...message, interrupted: true }
                  : message,
              ),
            );
          }

          // Keep the visible thread authoritative when the server stores
          // additional action-generated messages during a successful send.
          if (activeConversationIdRef.current === convId) {
            await loadConversationMessages(convId);
          }

          void loadConversations();
          if (elizaCloudEnabled || elizaCloudConnected) {
            void pollCloudCredits();
          }
        } catch (err) {
          const abortError = err as Error;
          if (abortError.name === "AbortError") {
            setConversationMessages((prev) =>
              prev.filter(
                (message) =>
                  !(message.id === assistantMsgId && !message.text.trim()),
              ),
            );
            return;
          }
          await loadConversationMessages(convId);
        } finally {
          if (chatAbortRef.current === controller) {
            chatAbortRef.current = null;
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
        if (controller == null && chatSendNonceRef.current === sendNonce) {
          chatSendBusyRef.current = false;
          if (chatSendQueueRef.current.length > 0) {
            void flushQueuedChatSends();
          }
        }
      }
    },
    [
      chatMode,
      activeConversationId,
      chatSendQueueRef,
      elizaCloudEnabled,
      elizaCloudConnected,
      flushQueuedChatSends,
      loadConversationMessages,
      loadConversations,
      pollCloudCredits,
      tab,
      uiLanguage,
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
    (assistantMsgId: string) => {
      let retryText: string | null = null;
      setConversationMessages((prev) => {
        // Find the interrupted assistant message
        const assistantIdx = prev.findIndex(
          (m) => m.id === assistantMsgId && m.role === "assistant",
        );
        if (assistantIdx < 0) return prev;

        // Find the preceding user message
        let userMsg: ConversationMessage | null = null;
        for (let i = assistantIdx - 1; i >= 0; i--) {
          if (prev[i].role === "user") {
            userMsg = prev[i];
            break;
          }
        }
        if (!userMsg) return prev;

        // Remove the interrupted assistant message
        const next = prev.filter((m) => m.id !== assistantMsgId);

        retryText = userMsg.text;

        return next;
      });
      if (retryText) {
        void sendChatText(retryText);
      }
    },
    [sendChatText, setConversationMessages],
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

// ── File-local helper (needed by runQueuedChatSend) ──────────────────

function shouldKeepConversationMessage(message: ConversationMessage): boolean {
  if (message.role !== "assistant") return true;
  if (message.text.trim().length > 0) return true;
  return Boolean(message.blocks?.length);
}

function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}
