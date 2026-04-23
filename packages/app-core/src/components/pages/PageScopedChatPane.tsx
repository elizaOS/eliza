import { ChatAttachmentStrip, Spinner, Textarea } from "@elizaos/ui";
import { ArrowUp, Mic, Plus, Sparkles, Square } from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type {
  Conversation,
  ConversationChannelType,
  ConversationMessage,
  ImageAttachment,
} from "../../api/client-types";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import { useApp } from "../../state";
import {
  buildPageScopedConversationMetadata,
  buildPageScopedRoutingMetadata,
  isPageScopedConversation,
  PAGE_SCOPE_COPY,
  type PageScope,
  resolvePageScopedConversation,
} from "./page-scoped-conversations";

const PAGE_CHAT_INPUT_MIN_HEIGHT_PX = 46;
const PAGE_CHAT_INPUT_MAX_HEIGHT_PX = 150;
const MAX_PAGE_CHAT_IMAGES = 4;

type PageScopedMessage = ConversationMessage & {
  images?: ImageAttachment[];
};

function resolveSpeechLocale(uiLanguage: string): string {
  switch (uiLanguage) {
    case "zh-CN":
      return "zh-CN";
    case "ko":
      return "ko-KR";
    case "es":
      return "es-ES";
    case "pt":
      return "pt-BR";
    case "vi":
      return "vi-VN";
    case "tl":
      return "fil-PH";
    default:
      return "en-US";
  }
}

interface PageScopedChatPaneProps {
  scope: PageScope;
  pageId?: string;
  /** Override the conversation title (defaults to PAGE_SCOPE_DEFAULT_TITLE[scope]). */
  title?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
  /**
   * Dynamic intro card override. When provided, replaces the static
   * PAGE_SCOPE_COPY[scope] intro text and can attach action buttons (used by
   * the Browser view to surface Agent Browser Bridge install buttons when the
   * extension is not yet connected).
   */
  introOverride?: {
    title?: string;
    body?: ReactNode;
    actions?: ReactNode;
  };
  /**
   * First-turn system addendum override — replaces PAGE_SCOPE_COPY[scope].systemAddendum
   * so the agent's first-turn grounding reflects current page state (e.g. the
   * Browser view tells the agent whether Agent Browser Bridge is connected).
   */
  systemAddendumOverride?: string;
  /** Override the composer placeholder text. */
  placeholderOverride?: string;
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
  introOverride,
  systemAddendumOverride,
  placeholderOverride,
}: PageScopedChatPaneProps) {
  const copy = PAGE_SCOPE_COPY[scope];
  const introTitle = introOverride?.title ?? copy.title;
  const introBody = introOverride?.body ?? copy.body;
  const introActions = introOverride?.actions ?? null;
  const effectiveSystemAddendum = systemAddendumOverride ?? copy.systemAddendum;
  const placeholder = placeholderOverride ?? "Message";
  const app = useApp();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<PageScopedMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
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
    setPendingImages([]);
    setAttachmentError(null);
    setImageDragOver(false);
    setVoicePreview("");
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

  const scrollVersion = `${messages.length}:${sending ? "sending" : "idle"}`;

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    void scrollVersion;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 150;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: nearBottom ? "auto" : "smooth",
      });
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [scrollVersion]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;

    if (!input) {
      textarea.style.height = `${PAGE_CHAT_INPUT_MIN_HEIGHT_PX}px`;
      textarea.style.overflowY = "hidden";
      return;
    }

    textarea.style.height = "auto";
    textarea.style.overflowY = "hidden";
    const height = Math.min(
      textarea.scrollHeight,
      PAGE_CHAT_INPUT_MAX_HEIGHT_PX,
    );
    textarea.style.height = `${height}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > PAGE_CHAT_INPUT_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [input]);

  const handleSend = useCallback(
    async (options?: {
      channelType?: ConversationChannelType;
      images?: ImageAttachment[];
      text?: string;
    }) => {
      const raw = (options?.text ?? input).trim();
      const images = options?.images ?? pendingImages;
      if ((!raw && images.length === 0) || !conversation || sending) return;

      const isFirstTurn = messages.length === 0;
      const textToSend = isFirstTurn
        ? `[SYSTEM]${effectiveSystemAddendum}[/SYSTEM]\n\n${raw}`
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
        {
          id: userId,
          images: images.length > 0 ? images : undefined,
          role: "user",
          text: raw,
          timestamp: now,
        },
        { id: assistantId, role: "assistant", text: "", timestamp: now },
      ]);
      setInput("");
      setPendingImages([]);
      setAttachmentError(null);
      setVoicePreview("");
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
          options?.channelType ?? "DM",
          controller.signal,
          images.length > 0 ? images : undefined,
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
    },
    [
      conversation,
      effectiveSystemAddendum,
      input,
      messages.length,
      pageId,
      pendingImages,
      scope,
      sending,
      sourceConversationId,
    ],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const disabled = !conversation || Boolean(loadError);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files)
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, MAX_PAGE_CHAT_IMAGES);
    if (imageFiles.length === 0) return;

    setAttachmentError(null);
    const readers = imageFiles.map(
      (file) =>
        new Promise<ImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result =
              typeof reader.result === "string" ? reader.result : "";
            const commaIndex = result.indexOf(",");
            const data =
              commaIndex >= 0 ? result.slice(commaIndex + 1) : result;
            resolve({ data, mimeType: file.type, name: file.name });
          };
          reader.onerror = () =>
            reject(reader.error ?? new Error("Failed to read image"));
          reader.onabort = () => reject(new Error("Image read aborted"));
          reader.readAsDataURL(file);
        }),
    );

    void Promise.all(readers)
      .then((attachments) => {
        setPendingImages((prev) =>
          [...prev, ...attachments].slice(0, MAX_PAGE_CHAT_IMAGES),
        );
      })
      .catch(() => {
        setAttachmentError("Failed to load image attachment.");
      });
  }, []);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) {
        addImageFiles(event.target.files);
      }
      event.target.value = "";
    },
    [addImageFiles],
  );

  const handleImageDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setImageDragOver(false);
      if (event.dataTransfer.files.length > 0) {
        addImageFiles(event.dataTransfer.files);
      }
    },
    [addImageFiles],
  );

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, current) => current !== index));
  }, []);

  const voice = useVoiceChat({
    cloudConnected:
      app.elizaCloudVoiceProxyAvailable || app.elizaCloudConnected || false,
    interruptOnSpeech: false,
    lang: resolveSpeechLocale(app.uiLanguage),
    onTranscript: (text) => {
      const transcript = text.trim();
      if (!transcript) return;
      setVoicePreview("");
      void handleSend({
        channelType: "VOICE_DM",
        images: [],
        text: transcript,
      });
    },
    onTranscriptPreview: (text) => {
      setVoicePreview(text);
    },
  });

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      if (voice.isListening) {
        void voice.stopListening();
        setVoicePreview("");
      }
      setInput(event.target.value);
    },
    [voice.isListening, voice.stopListening],
  );

  const handleVoiceAction = useCallback(() => {
    if (disabled || sending || !voice.supported) return;
    setVoicePreview("");
    if (voice.isListening) {
      void voice.stopListening({ submit: true });
      return;
    }
    void voice.startListening("compose");
  }, [
    disabled,
    sending,
    voice.isListening,
    voice.startListening,
    voice.stopListening,
    voice.supported,
  ]);

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
  const hasDraft = input.trim().length > 0 || pendingImages.length > 0;
  const actionLabel = hasDraft
    ? "Send"
    : voice.isListening
      ? "Stop voice input"
      : "Start voice input";

  return (
    <section
      data-testid={`page-scoped-chat-${scope}`}
      data-page-scope={scope}
      className={`flex min-h-0 flex-1 flex-col bg-bg transition-shadow ${
        imageDragOver ? "ring-1 ring-inset ring-accent/50" : ""
      } ${className ?? ""}`}
      aria-label={copy.title}
      onDragLeave={() => setImageDragOver(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setImageDragOver(true);
      }}
      onDrop={handleImageDrop}
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
              {introTitle}
            </div>
            <div className="text-sm leading-relaxed text-txt">{introBody}</div>
            {introActions ? (
              <div className="mt-3 flex flex-wrap gap-2">{introActions}</div>
            ) : null}
          </div>
        ) : null}

        {messages.map((message) => (
          <article
            key={message.id}
            className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
              message.role === "user"
                ? "ml-8 self-end bg-accent/10 text-txt"
                : "mr-8 bg-bg/40 text-txt"
            }`}
          >
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {message.role === "user" ? "You" : "Eliza"}
            </div>
            {message.images?.length ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {message.images.map((image) => (
                  <img
                    key={`${image.name}:${image.mimeType}:${image.data.length}:${image.data.slice(0, 24)}`}
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={image.name}
                    className="h-16 w-16 rounded-md border border-border/40 object-cover"
                  />
                ))}
              </div>
            ) : null}
            {message.text ? (
              <div className="whitespace-pre-wrap">{message.text}</div>
            ) : message.images?.length ? (
              <div className="text-muted">
                {message.images.length === 1
                  ? "Attached image"
                  : `Attached ${message.images.length} images`}
              </div>
            ) : null}
          </article>
        ))}

        {sending && !firstTokenReceived ? (
          <div className="mr-8 flex items-center gap-1.5 rounded-lg bg-bg/40 px-3 py-2">
            <Spinner size={12} className="text-accent/70" />
            <span className="text-[11px] text-muted">Thinking…</span>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border/30 px-3 py-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
        {attachmentError ? (
          <div className="pb-1 text-[11px] text-danger">{attachmentError}</div>
        ) : null}
        <ChatAttachmentStrip
          items={pendingImages.map((image, imageIndex) => ({
            alt: image.name,
            id: String(imageIndex),
            name: image.name,
            src: `data:${image.mimeType};base64,${image.data}`,
          }))}
          onRemove={(_id, index) => removeImage(index)}
        />
        <div
          data-testid={`page-scoped-chat-composer-${scope}`}
          className="flex min-h-[46px] items-end gap-1.5 rounded-full border border-border/40 bg-card/45 px-1.5 py-1.5 transition-colors focus-within:border-accent/50"
        >
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg/60 text-muted transition-colors hover:text-txt disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Add attachment"
            title="Add attachment"
            disabled={disabled || sending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus className="h-5 w-5" />
          </button>

          <div className="relative min-w-0 flex-1">
            <Textarea
              ref={composerRef}
              variant="default"
              className="h-[46px] max-h-[150px] min-h-0 w-full min-w-0 resize-none overflow-y-hidden rounded-none border-0 bg-transparent px-2 py-[11px] text-sm leading-[1.55] text-txt shadow-none outline-none placeholder:text-muted/60 focus:border-transparent focus:outline-none focus:ring-0 focus-visible:ring-0"
              rows={1}
              aria-label={copy.title}
              placeholder={
                voice.isListening
                  ? voicePreview
                    ? ""
                    : "Listening…"
                  : placeholder
              }
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={disabled || sending}
            />
            {voice.isListening && voicePreview ? (
              <div className="pointer-events-none absolute inset-x-2 bottom-2 truncate text-xs text-muted">
                {voicePreview}
              </div>
            ) : null}
          </div>

          {sending ? (
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger transition-colors hover:bg-danger/25"
              onClick={handleStop}
              aria-label="Stop"
              title="Stop"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : hasDraft ? (
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-txt text-bg transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void handleSend()}
              disabled={disabled}
              aria-label={actionLabel}
              title={actionLabel}
            >
              <ArrowUp className="h-4.5 w-4.5" />
            </button>
          ) : (
            <button
              type="button"
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                voice.isListening
                  ? "bg-accent text-bg"
                  : "bg-bg/60 text-muted hover:text-txt"
              }`}
              onClick={handleVoiceAction}
              disabled={disabled || !voice.supported}
              aria-label={actionLabel}
              aria-pressed={voice.isListening}
              title={voice.supported ? actionLabel : "Voice input unavailable"}
            >
              <Mic className="h-4.5 w-4.5" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
