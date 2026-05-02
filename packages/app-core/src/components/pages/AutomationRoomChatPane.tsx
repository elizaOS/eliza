import { Button, Spinner, Textarea } from "@elizaos/ui";
import { ChevronDown, ChevronUp, Send, Square, Zap } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type {
  Conversation,
  ConversationMessage,
  ConversationMetadata,
} from "../../api/client-types";
import { useApp } from "../../state";
import {
  buildAutomationResponseRoutingMetadata,
  resolveAutomationConversation,
} from "./automation-conversations";

interface AutomationRoomChatPaneProps {
  assistantLabel: string;
  collapsed: boolean;
  collapsible?: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  metadata: ConversationMetadata;
  onAutomationMutated: () => void;
  onConversationResolved?: (conversation: Conversation) => void;
  onToggleCollapse: () => void;
  placeholder: string;
  systemAddendum?: string;
  title: string;
}

const WORKFLOW_ACTION_KEYWORDS =
  /workflow|automation|cron|task|calendar|gmail|signal|telegram|discord|github|deploy|activate|deactivate|delete|create/i;

async function getAutomationConversationMessages(
  conversationId: string,
): Promise<ConversationMessage[]> {
  try {
    const { messages } = await client.getConversationMessages(conversationId);
    return messages;
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : String(error);
    if (
      status === 404 ||
      message.toLowerCase().includes("not found") ||
      message.includes("404")
    ) {
      throw error;
    }
    return [];
  }
}

// ── Custom event shapes ──────────────────────────────────────────────────────

interface WorkflowGeneratingDetail {
  workflowId?: string;
  inProgress: boolean;
}

interface ChatToolCallDetail {
  conversationId: string;
  toolName: string;
  active: boolean;
}

// ── Roving tabindex helpers ──────────────────────────────────────────────────

/** Move focus to a message element by index within a container. */
function focusMessageAt(container: HTMLElement, index: number): void {
  const items = container.querySelectorAll<HTMLElement>('[role="article"]');
  const target = items[index];
  if (target) {
    target.focus();
  }
}

export function AutomationRoomChatPane({
  assistantLabel,
  collapsed,
  collapsible = true,
  composerRef,
  metadata,
  onAutomationMutated,
  onConversationResolved,
  onToggleCollapse,
  placeholder,
  systemAddendum,
  title,
}: AutomationRoomChatPaneProps) {
  const { t } = useApp();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [firstTokenReceived, setFirstTokenReceived] = useState(false);

  // ── Tool-call chip state ─────────────────────────────────────────────────
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);

  // ── Scroll / "new messages" state ────────────────────────────────────────
  const [showNewMessages, setShowNewMessages] = useState(false);
  const isAtBottomRef = useRef(true);
  /** Timestamp of last user interaction outside the composer. */
  const lastExternalInteractionRef = useRef(0);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLUListElement>(null);
  const _conversationKey = useMemo(
    () =>
      JSON.stringify({
        title,
        metadata,
      }),
    [metadata, title],
  );

  // ── Conversation load ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
    setInput("");
    setLoadError(null);
    setSending(false);
    setFirstTokenReceived(false);
    setShowNewMessages(false);

    void (async () => {
      try {
        const conversation = await resolveAutomationConversation({
          title,
          metadata,
        });
        if (cancelled) {
          return;
        }

        setConversationId(conversation.id);
        onConversationResolved?.(conversation);

        const loadedMessages = await getAutomationConversationMessages(
          conversation.id,
        );
        if (cancelled) {
          return;
        }
        setMessages(loadedMessages);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const message = error instanceof Error ? error.message : String(error);
        if (
          status === 404 ||
          message.toLowerCase().includes("not found") ||
          message.includes("404")
        ) {
          const recreatedConversation = await resolveAutomationConversation({
            title,
            metadata,
          });
          if (cancelled) {
            return;
          }
          setConversationId(recreatedConversation.id);
          onConversationResolved?.(recreatedConversation);
          const recreatedMessages = await getAutomationConversationMessages(
            recreatedConversation.id,
          );
          if (!cancelled) {
            setMessages(recreatedMessages);
          }
          return;
        }
        if (!cancelled) {
          setLoadError(message || t("automations.chat.errorGeneric"));
        }
      }
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [metadata, onConversationResolved, title, t]);

  // ── Scroll-position tracking ─────────────────────────────────────────────
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const handleScroll = () => {
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      isAtBottomRef.current = distanceFromBottom < 60;
      if (isAtBottomRef.current) {
        setShowNewMessages(false);
      }
    };

    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", handleScroll);
    };
  }, []);

  // ── Auto-scroll / new-messages chip on content change ───────────────────
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (isAtBottomRef.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
      setShowNewMessages(false);
    } else {
      setShowNewMessages(true);
    }
  }, []);

  // ── Composer height resize ───────────────────────────────────────────────
  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    if (!input) {
      textarea.style.height = "38px";
      textarea.style.overflowY = "hidden";
      return;
    }
    textarea.style.height = "auto";
    textarea.style.overflowY = "hidden";
    const nextHeight = Math.min(textarea.scrollHeight, 150);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 150 ? "auto" : "hidden";
  }, [composerRef, input]);

  // ── eliza:automations:workflow-generating listener ──────────────────────
  useEffect(() => {
    const paneWorkflowId = metadata?.workflowId ?? null;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowGeneratingDetail>).detail;
      // Only show the chip if the event targets this pane's workflow (or is
      // broadcast without a specific workflowId).
      if (
        detail.workflowId !== undefined &&
        paneWorkflowId !== null &&
        detail.workflowId !== paneWorkflowId
      ) {
        return;
      }
      setActiveToolCall(
        detail.inProgress ? t("chat.toolCallChip.buildingWorkflow") : null,
      );
    };

    window.addEventListener("eliza:automations:workflow-generating", handler);
    return () => {
      window.removeEventListener(
        "eliza:automations:workflow-generating",
        handler,
      );
    };
  }, [metadata?.workflowId, t]);

  // ── eliza:automations:seed-composer listener ───────────────────────────
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string; select?: boolean }>)
        .detail;
      if (!detail?.text) return;
      setInput(detail.text);
      window.requestAnimationFrame(() => {
        const textarea = composerRef.current;
        if (!textarea) return;
        textarea.focus();
        if (detail.select) {
          textarea.select();
        }
      });
    };
    window.addEventListener("eliza:automations:seed-composer", handler);
    return () => {
      window.removeEventListener("eliza:automations:seed-composer", handler);
    };
  }, [composerRef]);

  // ── eliza:chat:tool-call generic listener ───────────────────────────────
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ChatToolCallDetail>).detail;
      if (detail.conversationId !== conversationId) {
        return;
      }
      if (!detail.active) {
        setActiveToolCall(null);
        return;
      }
      // t() with a dynamic key — use the toolName key, fall back to default.
      const specific = t(`chat.toolCallChip.${detail.toolName}`);
      const label =
        specific !== `chat.toolCallChip.${detail.toolName}`
          ? specific
          : t("chat.toolCallChip.default");
      setActiveToolCall(label);
    };

    window.addEventListener("eliza:chat:tool-call", handler);
    return () => {
      window.removeEventListener("eliza:chat:tool-call", handler);
    };
  }, [conversationId, t]);

  // ── Track external interactions for focus-return guard ───────────────────
  useEffect(() => {
    const markInteraction = (event: MouseEvent | FocusEvent) => {
      const composer = composerRef.current;
      if (
        composer &&
        event.target instanceof Node &&
        composer.contains(event.target)
      ) {
        return;
      }
      lastExternalInteractionRef.current = Date.now();
    };

    window.addEventListener("mousedown", markInteraction, { capture: true });
    window.addEventListener("focusin", markInteraction, { capture: true });
    return () => {
      window.removeEventListener("mousedown", markInteraction, {
        capture: true,
      });
      window.removeEventListener("focusin", markInteraction, { capture: true });
    };
  }, [composerRef]);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setShowNewMessages(false);
    isAtBottomRef.current = true;
  }, []);

  const handleSend = useCallback(async () => {
    const rawInput = input.trim();
    if (!rawInput || !conversationId || sending) {
      return;
    }

    const now = Date.now();
    const userMessageId = `automation-user-${now}`;
    const assistantMessageId = `automation-assistant-${now}`;
    const isFirstTurn = messages.length === 0;
    const routingMetadata = buildAutomationResponseRoutingMetadata(metadata);
    const textToSend =
      isFirstTurn && systemAddendum
        ? `[SYSTEM]${systemAddendum}[/SYSTEM]\n\n${rawInput}`
        : rawInput;

    setMessages((previous) => [
      ...previous,
      { id: userMessageId, role: "user", text: rawInput, timestamp: now },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "",
        timestamp: now,
      },
    ]);
    setInput("");
    setSending(true);
    setFirstTokenReceived(false);

    const controller = new AbortController();
    abortRef.current = controller;
    let streamedText = "";

    try {
      const response = await client.sendConversationMessageStream(
        conversationId,
        textToSend,
        (token) => {
          if (!token) return;
          const delta = token.slice(streamedText.length);
          if (!delta) return;
          streamedText += delta;
          setFirstTokenReceived(true);
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? { ...message, text: message.text + delta }
                : message,
            ),
          );
        },
        "DM",
        controller.signal,
        undefined,
        undefined,
        routingMetadata,
      );

      if (response.text && response.text !== streamedText) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId
              ? { ...message, text: response.text }
              : message,
          ),
        );
      }

      if (WORKFLOW_ACTION_KEYWORDS.test(response.text ?? streamedText)) {
        onAutomationMutated();
      }
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        return;
      }
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId
            ? { ...message, text: t("automations.chat.errorGeneric") }
            : message,
        ),
      );
    } finally {
      setSending(false);
      setActiveToolCall(null);
      abortRef.current = null;

      // Return focus to composer unless the user clicked away in the last 3 s.
      const msSinceExternalInteraction =
        Date.now() - lastExternalInteractionRef.current;
      if (msSinceExternalInteraction > 3000) {
        composerRef.current?.focus();
      }
    }
  }, [
    composerRef,
    conversationId,
    input,
    messages.length,
    metadata,
    onAutomationMutated,
    sending,
    systemAddendum,
    t,
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (sending) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend, sending],
  );

  // ── Roving tabindex: arrow-key navigation between message bubbles ─────────
  const handleMessageListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (!messageListRef.current) return;
      const items = Array.from(
        messageListRef.current.querySelectorAll<HTMLElement>(
          "[data-message-item]",
        ),
      );
      const focused = document.activeElement as HTMLElement | null;
      const currentIndex = focused ? items.indexOf(focused) : -1;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        const nextIndex = Math.min(currentIndex + 1, items.length - 1);
        focusMessageAt(messageListRef.current, nextIndex);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const prevIndex = Math.max(currentIndex - 1, 0);
        focusMessageAt(messageListRef.current, prevIndex);
      }
    },
    [],
  );

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          !(
            sending &&
            !firstTokenReceived &&
            message.role === "assistant" &&
            !message.text.trim()
          ),
      ),
    [firstTokenReceived, messages, sending],
  );

  if (collapsed && collapsible) {
    return (
      <div className="overflow-hidden rounded-xl border border-border/40 bg-card/60">
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2 px-4 py-2.5 text-left transition-colors hover:bg-bg/50"
          onClick={onToggleCollapse}
          aria-label={t("automations.chat.expand")}
        >
          <Zap className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="flex-1 text-xs font-semibold text-txt-strong">
            {assistantLabel}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        </Button>
      </div>
    );
  }

  return (
    <section
      className="flex flex-col overflow-hidden rounded-xl border border-border/40 bg-card/60"
      style={{ minHeight: 0 }}
      aria-label={assistantLabel}
    >
      {collapsible ? (
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2 border-b border-border/30 px-4 py-2.5 text-left transition-colors hover:bg-bg/50"
          onClick={onToggleCollapse}
          aria-label={t("automations.chat.collapse")}
        >
          <Zap className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="flex-1 text-xs font-semibold text-txt-strong">
            {assistantLabel}
          </span>
          <ChevronUp className="h-3.5 w-3.5 text-muted" />
        </Button>
      ) : (
        <div className="flex items-center gap-2 border-b border-border/30 px-4 py-2.5">
          <Zap className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="flex-1 text-xs font-semibold text-txt-strong">
            {assistantLabel}
          </span>
        </div>
      )}

      {/* Message scroll region */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-atomic="false"
          className="flex flex-1 flex-col overflow-y-auto px-3 py-2"
          style={{ maxHeight: "240px", minHeight: "80px" }}
        >
          {visibleMessages.length === 0 && !sending ? (
            <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
              <p className="text-sm text-muted">{loadError ?? placeholder}</p>
            </div>
          ) : (
            <ul
              ref={messageListRef}
              className="w-full space-y-1"
              onKeyDown={handleMessageListKeyDown}
            >
              {visibleMessages.map((message, index) => {
                const preview = message.text.slice(0, 80);
                const ariaLabel =
                  message.role === "user"
                    ? t("chat.messageAriaLabelUser", { preview })
                    : t("chat.messageAriaLabelAgent", { preview });
                return (
                  <li
                    key={message.id}
                    data-message-item="true"
                    tabIndex={index === visibleMessages.length - 1 ? 0 : -1}
                    aria-label={ariaLabel}
                    className={`rounded-lg px-3 py-2 text-sm leading-relaxed focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
                      message.role === "user"
                        ? "ml-8 self-end bg-accent/10 text-txt"
                        : "mr-8 bg-bg/50 text-txt"
                    }`}
                  >
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {message.role === "user"
                        ? t("automations.chat.roleUser")
                        : t("common.agent")}
                    </div>
                    <div className="whitespace-pre-wrap">{message.text}</div>
                  </li>
                );
              })}

              {/* Typing indicator while waiting for first token */}
              {sending && !firstTokenReceived && (
                <div className="mr-8 rounded-lg bg-bg/50 px-3 py-2">
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {t("common.agent")}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:300ms]" />
                  </div>
                </div>
              )}

              {/* Tool-call chip — rendered as last transcript item */}
              {activeToolCall && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mr-8 flex items-center gap-2 rounded-lg border border-border/30 bg-bg/30 px-3 py-1.5"
                >
                  <Spinner size={12} className="text-accent/70" />
                  <span className="text-[11px] text-muted">
                    {activeToolCall}
                  </span>
                </div>
              )}
            </ul>
          )}
        </div>

        {/* "New messages" chip */}
        {showNewMessages && (
          <div
            role="status"
            aria-live="polite"
            className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2"
          >
            <Button
              type="button"
              variant="default"
              className="h-7 gap-1.5 rounded-full px-3 text-xs shadow-md"
              aria-label={t("chat.newMessagesChip")}
              onClick={scrollToBottom}
            >
              {t("chat.newMessagesChip")}
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-end gap-1.5 border-t border-border/30 px-3 py-2">
        <Textarea
          ref={composerRef}
          variant="default"
          className="min-h-[38px] max-h-[150px] flex-1 min-w-0 resize-none overflow-y-hidden rounded-lg border border-border/40 bg-bg/40 px-3 py-2 text-sm text-txt placeholder:text-muted/60 focus:border-accent/40 focus:outline-none focus-visible:ring-0"
          rows={1}
          aria-label={assistantLabel}
          placeholder={placeholder}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending || !conversationId || Boolean(loadError)}
        />
        {sending ? (
          <Button
            variant="destructive"
            className="h-[38px] shrink-0 gap-1.5 px-3 text-sm"
            onClick={handleStop}
            title={t("common.stop")}
          >
            <Square className="h-3 w-3 fill-current" />
            <span>{t("common.stop")}</span>
          </Button>
        ) : (
          <Button
            variant="default"
            className="h-[38px] shrink-0 gap-1.5 px-4 text-sm"
            onClick={() => void handleSend()}
            disabled={!input.trim() || !conversationId || Boolean(loadError)}
            aria-label={t("common.send")}
          >
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">{t("common.send")}</span>
          </Button>
        )}
      </div>
    </section>
  );
}
