import { Button, Spinner, Textarea } from "@elizaos/ui";
import { Send, Sparkles, Square } from "lucide-react";
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
} from "../../api/client-types";
import { useApp } from "../../state";
import {
  buildPageScopedConversationMetadata,
  buildPageScopedRoutingMetadata,
  isPageScopedConversation,
  PAGE_SCOPE_COPY,
  type PageScope,
  resolvePageScopedConversation,
} from "./page-scoped-conversations";

interface PageScopedChatPaneProps {
  scope: PageScope;
  pageId?: string;
  /** Override the conversation title (defaults to PAGE_SCOPE_DEFAULT_TITLE[scope]). */
  title?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
}

function shallowEqual(
  left: Readonly<Record<string, unknown>> | null | undefined,
  right: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((k) => left[k] === right[k]);
}

export function PageScopedChatPane({
  scope,
  pageId,
  title,
  className,
}: PageScopedChatPaneProps) {
  const copy = PAGE_SCOPE_COPY[scope];
  const app = useApp();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [firstTokenReceived, setFirstTokenReceived] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The "main chat" awareness link: only treat the global active conversation
  // as a source when it's a non-page, non-automation conversation (i.e. a
  // real general chat).
  const sourceConversationId = useMemo(() => {
    const activeId = app.activeConversationId;
    if (!activeId) return undefined;
    if (conversation && activeId === conversation.id) return undefined;
    const active = app.conversations.find((c) => c.id === activeId);
    if (!active) return undefined;
    if (isPageScopedConversation(active)) return undefined;
    if (active.metadata?.scope?.startsWith("automation-")) return undefined;
    return activeId;
  }, [app.activeConversationId, app.conversations, conversation]);

  // Resolve the page-scoped conversation on mount / scope change.
  useEffect(() => {
    let cancelled = false;
    abortRef.current?.abort();
    setConversation(null);
    setMessages([]);
    setInput("");
    setSending(false);
    setFirstTokenReceived(false);
    setLoadError(null);

    void (async () => {
      try {
        const next = await resolvePageScopedConversation({
          scope,
          title,
          pageId,
        });
        if (cancelled) return;
        setConversation(next);
        const { messages: history } = await client.getConversationMessages(
          next.id,
        );
        if (cancelled) return;
        setMessages(history);
      } catch (cause) {
        if (cancelled) return;
        const message =
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Failed to load page chat.";
        setLoadError(message);
      }
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [scope, pageId, title]);

  // When the linked source conversation changes, restamp room metadata so the
  // page-scoped-context provider sees the current main-chat target.
  useEffect(() => {
    if (!conversation) return;
    const desiredSource = sourceConversationId;
    const currentSource =
      conversation.metadata?.sourceConversationId ?? undefined;
    if (desiredSource === currentSource) return;

    const desiredMetadata = buildPageScopedConversationMetadata(scope, {
      pageId,
      sourceConversationId: desiredSource,
    });
    if (
      shallowEqual(
        conversation.metadata as Readonly<Record<string, unknown>> | undefined,
        desiredMetadata as Readonly<Record<string, unknown>>,
      )
    )
      return;

    let cancelled = false;
    void (async () => {
      try {
        const { conversation: next } = await client.updateConversation(
          conversation.id,
          { metadata: desiredMetadata },
        );
        if (!cancelled) setConversation(next);
      } catch {
        // Non-fatal — stale source-tail just won't appear in provider context.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation, sourceConversationId, scope, pageId]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const handleSend = useCallback(async () => {
    const raw = input.trim();
    if (!raw || !conversation || sending) return;

    const isFirstTurn = messages.length === 0;
    const textToSend = isFirstTurn
      ? `[SYSTEM]${copy.systemAddendum}[/SYSTEM]\n\n${raw}`
      : raw;
    const routingMetadata = buildPageScopedRoutingMetadata(scope, {
      pageId,
      sourceConversationId,
    });

    const now = Date.now();
    const userId = `page-${scope}-user-${now}`;
    const assistantId = `page-${scope}-assistant-${now}`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: raw, timestamp: now },
      { id: assistantId, role: "assistant", text: "", timestamp: now },
    ]);
    setInput("");
    setSending(true);
    setFirstTokenReceived(false);

    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = "";

    try {
      const response = await client.sendConversationMessageStream(
        conversation.id,
        textToSend,
        (token) => {
          if (!token) return;
          const delta = token.slice(streamed.length);
          if (!delta) return;
          streamed += delta;
          setFirstTokenReceived(true);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, text: m.text + delta } : m,
            ),
          );
        },
        "DM",
        controller.signal,
        undefined,
        undefined,
        routingMetadata,
      );
      if (response.text && response.text !== streamed) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, text: response.text } : m,
          ),
        );
      }
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text: "Sorry — that didn't go through. Try again?" }
            : m,
        ),
      );
    } finally {
      setSending(false);
      abortRef.current = null;
      composerRef.current?.focus();
    }
  }, [
    conversation,
    copy.systemAddendum,
    input,
    messages.length,
    pageId,
    scope,
    sending,
    sourceConversationId,
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

  const showIntro = messages.length === 0 && !sending;
  const disabled = !conversation || Boolean(loadError);

  return (
    <section
      data-testid={`page-scoped-chat-${scope}`}
      data-page-scope={scope}
      className={`flex min-h-0 flex-1 flex-col bg-bg ${className ?? ""}`}
      aria-label={copy.title}
    >
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      >
        {loadError ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {loadError}
          </div>
        ) : null}

        {showIntro ? (
          <div
            data-testid={`page-scoped-chat-intro-${scope}`}
            className="rounded-xl border border-border/40 bg-card/50 p-3"
          >
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              {copy.title}
            </div>
            <p className="text-sm leading-relaxed text-txt">{copy.body}</p>
          </div>
        ) : null}

        {messages.map((message) => (
          <div
            key={message.id}
            role="article"
            className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
              message.role === "user"
                ? "ml-8 self-end bg-accent/10 text-txt"
                : "mr-8 bg-bg/40 text-txt"
            }`}
          >
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {message.role === "user" ? "You" : "Eliza"}
            </div>
            <div className="whitespace-pre-wrap">{message.text}</div>
          </div>
        ))}

        {sending && !firstTokenReceived ? (
          <div className="mr-8 flex items-center gap-1.5 rounded-lg bg-bg/40 px-3 py-2">
            <Spinner size={12} className="text-accent/70" />
            <span className="text-[11px] text-muted">Thinking…</span>
          </div>
        ) : null}
      </div>

      <div className="flex items-end gap-1.5 border-t border-border/30 px-3 py-2">
        <Textarea
          ref={composerRef}
          variant="default"
          className="min-h-[38px] max-h-[150px] flex-1 min-w-0 resize-none overflow-y-hidden rounded-lg border border-border/40 bg-bg/40 px-3 py-2 text-sm text-txt placeholder:text-muted/60 focus:border-accent/40 focus:outline-none focus-visible:ring-0"
          rows={1}
          aria-label={copy.title}
          placeholder={copy.body.split(".")[0]}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
        />
        {sending ? (
          <Button
            variant="destructive"
            className="h-[38px] shrink-0 gap-1.5 px-3 text-sm"
            onClick={handleStop}
            title="Stop"
          >
            <Square className="h-3 w-3 fill-current" />
          </Button>
        ) : (
          <Button
            variant="default"
            className="h-[38px] shrink-0 gap-1.5 px-4 text-sm"
            onClick={() => void handleSend()}
            disabled={!input.trim() || disabled}
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </section>
  );
}
