import {
  Button,
  Textarea,
} from "@elizaos/ui";
import {
  ChevronDown,
  ChevronUp,
  Send,
  Square,
  Zap,
} from "lucide-react";
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
import { resolveAutomationConversation } from "./automation-conversations";

interface AutomationRoomChatPaneProps {
  assistantLabel: string;
  collapsed: boolean;
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

export function AutomationRoomChatPane({
  assistantLabel,
  collapsed,
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
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationKey = useMemo(
    () =>
      JSON.stringify({
        title,
        metadata,
      }),
    [metadata, title],
  );

  useEffect(() => {
    let cancelled = false;

    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
    setInput("");
    setLoadError(null);
    setSending(false);
    setFirstTokenReceived(false);

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

        const { messages: loadedMessages } =
          await client.getConversationMessages(conversation.id);
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
          const { messages: recreatedMessages } =
            await client.getConversationMessages(recreatedConversation.id);
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
  }, [conversationKey, metadata, onConversationResolved, title]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: distanceFromBottom < 150 ? "auto" : "smooth",
    });
  }, [messages, sending]);

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
    textarea.style.overflowY =
      textarea.scrollHeight > 150 ? "auto" : "hidden";
  }, [composerRef, input]);

  const handleSend = useCallback(async () => {
    const rawInput = input.trim();
    if (!rawInput || !conversationId || sending) {
      return;
    }

    const now = Date.now();
    const userMessageId = `automation-user-${now}`;
    const assistantMessageId = `automation-assistant-${now}`;
    const isFirstTurn = messages.length === 0;
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
      abortRef.current = null;
    }
  }, [
    conversationId,
    input,
    messages.length,
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

  if (collapsed) {
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
            <p className="text-sm text-muted">
              {loadError ?? placeholder}
            </p>
          </div>
        ) : (
          <div className="w-full space-y-1">
            {visibleMessages.map((message) => (
              <div
                key={message.id}
                className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  message.role === "user"
                    ? "ml-8 self-end bg-accent/10 text-txt"
                    : "mr-8 bg-bg/50 text-txt"
                }`}
              >
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {message.role === "user"
                    ? t("automations.chat.roleUser")
                    : t("automations.chat.roleAssistant")}
                </div>
                <div className="whitespace-pre-wrap">{message.text}</div>
              </div>
            ))}
            {sending && !firstTokenReceived && (
              <div className="mr-8 rounded-lg bg-bg/50 px-3 py-2">
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {t("automations.chat.roleAssistant")}
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
            title={t("automations.chat.stop")}
          >
            <Square className="h-3 w-3 fill-current" />
            <span>{t("automations.chat.stop")}</span>
          </Button>
        ) : (
          <Button
            variant="default"
            className="h-[38px] shrink-0 gap-1.5 px-4 text-sm"
            onClick={() => void handleSend()}
            disabled={!input.trim() || !conversationId || Boolean(loadError)}
            aria-label={t("automations.chat.send")}
          >
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">
              {t("automations.chat.send")}
            </span>
          </Button>
        )}
      </div>
    </section>
  );
}
