import { Button, Spinner, Textarea } from "@elizaos/ui";
import { ChevronDown, Send, Square, Trash2 } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type { ConversationMessage } from "../../api/client-types";
import { useApp } from "../../state";
import {
  buildPageConversationMetadata,
  buildPageResponseRoutingMetadata,
  type PageScope,
  resolveScopedConversation,
} from "./scoped-conversations";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PageScopedChatProps {
  scope: PageScope;
  pageId?: string;
  title: string;
  systemAddendum: string;
  placeholder: string;
  bridgeFromConversationId?: string | null;
  onClear?: () => void;
}

// ── Context bridge helpers ────────────────────────────────────────────────────

const BRIDGE_CHAR_BUDGET = 32_000;

function buildBridgePrefix(
  bridgeMessages: ConversationMessage[],
  systemAddendum: string,
  userInput: string,
): string {
  let accumulated = 0;
  const tail: ConversationMessage[] = [];

  for (let i = bridgeMessages.length - 1; i >= 0; i--) {
    const msg = bridgeMessages[i];
    const line = `${msg.role}: ${msg.text}\n`;
    if (accumulated + line.length > BRIDGE_CHAR_BUDGET) {
      break;
    }
    tail.unshift(msg);
    accumulated += line.length;
  }

  const contextBlock =
    tail.length > 0
      ? `[CONTEXT FROM MAIN CHAT]\n${tail
          .map((m) => `${m.role}: ${m.text}`)
          .join("\n")}\n[/CONTEXT]\n\n`
      : "";

  return `${contextBlock}[SYSTEM]${systemAddendum}[/SYSTEM]\n\n${userInput}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PageScopedChat({
  scope,
  pageId,
  title,
  systemAddendum,
  placeholder,
  bridgeFromConversationId,
  onClear,
}: PageScopedChatProps) {
  const { t } = useApp();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [firstTokenReceived, setFirstTokenReceived] = useState(false);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [clearing, setClearing] = useState(false);

  const isAtBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  const metadata = useMemo(
    () =>
      buildPageConversationMetadata(
        scope,
        pageId,
        bridgeFromConversationId ?? undefined,
      ),
    [scope, pageId, bridgeFromConversationId],
  );

  // ── Conversation load ──────────────────────────────────────────────────────
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
      const conversation = await resolveScopedConversation({ title, metadata });
      if (cancelled) {
        return;
      }

      setConversationId(conversation.id);

      const { messages: loadedMessages } = await client.getConversationMessages(
        conversation.id,
      );
      if (cancelled) {
        return;
      }
      setMessages(loadedMessages);
    })().catch((error: unknown) => {
      if (cancelled) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [metadata, title]);

  // ── Scroll-position tracking ───────────────────────────────────────────────
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

  // ── Auto-scroll on content change ─────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages and sending are intentional triggers, not subscribable deps
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (isAtBottomRef.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
      setShowNewMessages(false);
    } else {
      setShowNewMessages(true);
    }
  }, [messages, sending]);

  // ── Composer height resize ─────────────────────────────────────────────────
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
  }, [input]);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setShowNewMessages(false);
    isAtBottomRef.current = true;
  }, []);

  // ── Send ───────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const rawInput = input.trim();
    if (!rawInput || !conversationId || sending) {
      return;
    }

    const now = Date.now();
    const userMessageId = `page-user-${now}`;
    const assistantMessageId = `page-assistant-${now}`;
    const isFirstTurn = messages.length === 0;
    const routingMetadata = buildPageResponseRoutingMetadata(metadata);

    let textToSend = rawInput;
    if (isFirstTurn) {
      if (bridgeFromConversationId) {
        const { messages: bridgeMessages } = await client
          .getConversationMessages(bridgeFromConversationId)
          .catch(() => ({ messages: [] as ConversationMessage[] }));
        textToSend = buildBridgePrefix(
          bridgeMessages,
          systemAddendum,
          rawInput,
        );
      } else {
        textToSend = `[SYSTEM]${systemAddendum}[/SYSTEM]\n\n${rawInput}`;
      }
    }

    setMessages((previous) => [
      ...previous,
      { id: userMessageId, role: "user", text: rawInput, timestamp: now },
      { id: assistantMessageId, role: "assistant", text: "", timestamp: now },
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
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        return;
      }
      const errorText = t("chat.errorGeneric", {
        defaultValue: "Something went wrong. Please try again.",
      });
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId
            ? { ...message, text: errorText }
            : message,
        ),
      );
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [
    bridgeFromConversationId,
    conversationId,
    input,
    messages.length,
    metadata,
    sending,
    systemAddendum,
    t,
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (sending) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend, sending],
  );

  // ── Roving tabindex: arrow-key navigation between message bubbles ──────────
  const handleMessageListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!messageListRef.current) return;
      const items = Array.from(
        messageListRef.current.querySelectorAll<HTMLElement>("article"),
      );
      const focused = document.activeElement as HTMLElement | null;
      const currentIndex = focused ? items.indexOf(focused) : -1;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        const target = items[Math.min(currentIndex + 1, items.length - 1)];
        target?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const target = items[Math.max(currentIndex - 1, 0)];
        target?.focus();
      }
    },
    [],
  );

  // ── Clear ──────────────────────────────────────────────────────────────────
  const handleClear = useCallback(async () => {
    if (!conversationId || clearing) return;

    setClearing(true);
    abortRef.current?.abort();

    try {
      await client.deleteConversation(conversationId);
    } finally {
      setClearing(false);
    }

    // Re-resolve (creates a fresh conversation)
    setConversationId(null);
    setMessages([]);
    setLoadError(null);

    const conversation = await resolveScopedConversation({
      title,
      metadata,
    }).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
      return null;
    });

    if (conversation) {
      setConversationId(conversation.id);
      onClear?.();
    }
  }, [clearing, conversationId, metadata, onClear, title]);

  // ── Visible messages (suppress empty assistant placeholder) ───────────────
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

  return (
    <section
      className="flex h-full flex-1 flex-col overflow-hidden"
      style={{ minHeight: 0 }}
      aria-label={title}
    >
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/30 px-3">
        <span className="text-xs font-semibold text-txt-strong">{title}</span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-destructive disabled:opacity-40"
          aria-label={t("chat.clearConversation", {
            defaultValue: "Clear conversation",
          })}
          onClick={() => void handleClear()}
          disabled={!conversationId || clearing}
        >
          {clearing ? (
            <Spinner size={12} />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Message scroll region */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-atomic="false"
          className="flex flex-1 flex-col overflow-y-auto px-3 py-2"
        >
          {visibleMessages.length === 0 && !sending ? (
            <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
              <p className="text-sm text-muted">{loadError ?? placeholder}</p>
            </div>
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: roving tabindex keyboard handler
            <div
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
                  <article
                    key={message.id}
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
                        ? t("automations.chat.roleUser", {
                            defaultValue: "You",
                          })
                        : t("automations.chat.roleAssistant", {
                            defaultValue: "Assistant",
                          })}
                    </div>
                    <div className="whitespace-pre-wrap">{message.text}</div>
                  </article>
                );
              })}

              {/* Typing indicator while waiting for first token */}
              {sending && !firstTokenReceived && (
                <div className="mr-8 rounded-lg bg-bg/50 px-3 py-2">
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {t("automations.chat.roleAssistant", {
                      defaultValue: "Assistant",
                    })}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:300ms]" />
                  </div>
                </div>
              )}
            </div>
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
              aria-label={t("chat.newMessagesChip", {
                defaultValue: "New messages",
              })}
              onClick={scrollToBottom}
            >
              <ChevronDown className="h-3 w-3" />
              {t("chat.newMessagesChip", { defaultValue: "New messages" })}
            </Button>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-end gap-1.5 border-t border-border/30 px-3 py-2">
        <Textarea
          ref={composerRef}
          variant="default"
          className="min-h-[38px] max-h-[150px] flex-1 min-w-0 resize-none overflow-y-hidden rounded-lg border border-border/40 bg-bg/40 px-3 py-2 text-sm text-txt placeholder:text-muted/60 focus:border-accent/40 focus:outline-none focus-visible:ring-0"
          rows={1}
          aria-label={title}
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
            title={t("automations.chat.stop", { defaultValue: "Stop" })}
          >
            <Square className="h-3 w-3 fill-current" />
            <span>{t("automations.chat.stop", { defaultValue: "Stop" })}</span>
          </Button>
        ) : (
          <Button
            variant="default"
            className="h-[38px] shrink-0 gap-1.5 px-4 text-sm"
            onClick={() => void handleSend()}
            disabled={!input.trim() || !conversationId || Boolean(loadError)}
            aria-label={t("automations.chat.send", { defaultValue: "Send" })}
          >
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">
              {t("automations.chat.send", { defaultValue: "Send" })}
            </span>
          </Button>
        )}
      </div>
    </section>
  );
}
