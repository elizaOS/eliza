import { ChatAttachmentStrip } from "../composites/chat/chat-attachment-strip";
import { ChatComposer } from "../composites/chat/chat-composer";
import { Spinner } from "../ui/spinner";
import { RotateCcw, Sparkles } from "lucide-react";
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
import { useConnectorSendAsAccount } from "../../hooks/useConnectorSendAsAccount";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import { useApp } from "../../state";
import { AccountRequiredCard } from "../chat/AccountRequiredCard";
import { ConnectorAccountPicker } from "../chat/ConnectorAccountPicker";
import {
  type ConnectorSendAsContext,
  connectorAccountDisplayName,
  connectorWriteConfirmationKey,
  isLikelyAccountRequiredError,
  mergeConnectorSendAsMetadata,
} from "../chat/connector-send-as";
import {
  buildPageScopedConversationMetadata,
  buildPageScopedRoutingMetadata,
  isPageScopedConversation,
  PAGE_SCOPE_COPY,
  type PageScope,
  resetPageScopedConversation,
  resolvePageScopedConversation,
} from "./page-scoped-conversations";

const MAX_PAGE_CHAT_IMAGES = 4;
const CHAT_PREFILL_EVENT = "eliza:chat:prefill";

interface ChatPrefillDetail {
  text?: string;
  select?: boolean;
}

type PageScopedMessage = ConversationMessage & {
  images?: ImageAttachment[];
};

async function getPageScopedConversationMessages(
  conversationId: string,
): Promise<PageScopedMessage[]> {
  try {
    const { messages } = await client.getConversationMessages(conversationId);
    return messages;
  } catch {
    return [];
  }
}

function readChatPrefillDetail(event: Event): ChatPrefillDetail | null {
  const detail = (event as CustomEvent<ChatPrefillDetail>).detail;
  if (!detail || typeof detail.text !== "string" || detail.text.length === 0) {
    return null;
  }
  return detail;
}

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

export interface PageScopedChatPaneProps {
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
  /** Keep the intro visible above the thread, even after the chat has history. */
  persistentIntro?: boolean;
  /** Optional footer actions rendered inline with the Clear control. */
  footerActions?: ReactNode;
  /** Optional connector account context for page chat surfaces that can write through a connector. */
  connectorContext?: ConnectorSendAsContext | null;
  /**
   * Optional conversation adapter for surfaces that want to reuse the shared
   * sidebar chat UI but resolve a non-page-scoped conversation under the hood.
   */
  conversationAdapter?: {
    allowClear?: boolean;
    buildRoutingMetadata?: () => Record<string, unknown> | undefined;
    identityKey: string;
    onAfterSend?: () => void;
    onConversationResolved?: (conversation: Conversation) => void;
    resolveConversation: () => Promise<Conversation>;
  };
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
  persistentIntro = false,
  footerActions,
  connectorContext,
  conversationAdapter,
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
  const conversationAdapterRef = useRef(conversationAdapter);

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<PageScopedMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [sending, setSending] = useState(false);
  const [firstTokenReceived, setFirstTokenReceived] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accountRequiredReason, setAccountRequiredReason] = useState<
    string | null
  >(null);
  const [pendingWriteConfirmationKey, setPendingWriteConfirmationKey] =
    useState<string | null>(null);
  const [confirmedWriteAccountKeys, setConfirmedWriteAccountKeys] = useState<
    Set<string>
  >(() => new Set());
  const conversationAdapterIdentityKey = conversationAdapter?.identityKey;
  const hasConversationAdapter = Boolean(conversationAdapter);
  const connectorSendAs = useConnectorSendAsAccount(connectorContext, {
    setActionNotice: app.setActionNotice,
  });
  const {
    accountRequired,
    accountRequiredReason: connectorAccountRequiredReason,
    accounts: sendAsAccounts,
    connectAccount,
    context: normalizedSendAsContext,
    loading: sendAsLoading,
    reconnectAccount,
    saving: sendAsSaving,
    selectAccount,
    selectedAccount: sendAsSelectedAccount,
    sendAsMetadata,
    showPicker: showSendAsPicker,
  } = connectorSendAs;
  const sourceLabel =
    normalizedSendAsContext?.source ??
    normalizedSendAsContext?.provider ??
    "Connector";
  const currentWriteConfirmationKey = connectorWriteConfirmationKey(
    connectorContext,
    sendAsSelectedAccount,
  );
  const showWriteConfirmation =
    Boolean(pendingWriteConfirmationKey) &&
    pendingWriteConfirmationKey === currentWriteConfirmationKey;
  const sendAsConnectBusy = normalizedSendAsContext
    ? sendAsSaving.has(
        `add:${normalizedSendAsContext.provider}:${normalizedSendAsContext.connectorId}`,
      )
    : false;
  const blockingAccountReason =
    accountRequiredReason ??
    (accountRequired ? connectorAccountRequiredReason : null);

  useEffect(() => {
    conversationAdapterRef.current = conversationAdapter;
  }, [conversationAdapter]);

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
    void conversationAdapterIdentityKey;
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
    setAccountRequiredReason(null);
    setPendingWriteConfirmationKey(null);

    void (async () => {
      try {
        const adapter = conversationAdapterRef.current;
        const next = adapter
          ? await adapter.resolveConversation()
          : await resolvePageScopedConversation({
              scope,
              title,
              pageId,
            });
        if (cancelled) return;
        setConversation(next);
        adapter?.onConversationResolved?.(next);
        const history = await getPageScopedConversationMessages(next.id);
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
  }, [conversationAdapterIdentityKey, pageId, scope, title]);

  // When the linked source conversation changes, restamp room metadata so the
  // page-scoped-context provider sees the current main-chat target.
  useEffect(() => {
    if (hasConversationAdapter) return;
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
  }, [
    conversation,
    hasConversationAdapter,
    sourceConversationId,
    scope,
    pageId,
  ]);

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

  const handleSelectSendAsAccount = useCallback(
    (accountId: string) => {
      const account = sendAsAccounts.find((item) => item.id === accountId);
      selectAccount(accountId);
      setAccountRequiredReason(null);
      const key = connectorWriteConfirmationKey(connectorContext, account);
      if (key && !confirmedWriteAccountKeys.has(key)) {
        setPendingWriteConfirmationKey(key);
      }
    },
    [
      confirmedWriteAccountKeys,
      connectorContext,
      selectAccount,
      sendAsAccounts,
    ],
  );

  const handleConfirmWriteAccount = useCallback(() => {
    if (!currentWriteConfirmationKey) return;
    setConfirmedWriteAccountKeys((prev) => {
      const next = new Set(prev);
      next.add(currentWriteConfirmationKey);
      return next;
    });
    setPendingWriteConfirmationKey(null);
    setLoadError(null);
  }, [currentWriteConfirmationKey]);

  const handleConnectSendAsAccount = useCallback(() => {
    setAccountRequiredReason(null);
    void connectAccount().catch((error) => {
      setLoadError(
        error instanceof Error ? error.message : "Failed to connect account.",
      );
    });
  }, [connectAccount]);

  const handleReconnectSendAsAccount = useCallback(
    (accountId: string) => {
      setAccountRequiredReason(null);
      void reconnectAccount(accountId).catch((error) => {
        setLoadError(
          error instanceof Error
            ? error.message
            : "Failed to reconnect account.",
        );
      });
    },
    [reconnectAccount],
  );

  const handleSend = useCallback(
    async (options?: {
      channelType?: ConversationChannelType;
      images?: ImageAttachment[];
      text?: string;
    }) => {
      const raw = (options?.text ?? input).trim();
      const images = options?.images ?? pendingImages;
      if ((!raw && images.length === 0) || !conversation || sending) return;
      if (blockingAccountReason) {
        setLoadError(blockingAccountReason);
        return;
      }
      if (showWriteConfirmation) {
        setLoadError("Confirm the send-as account before sending.");
        return;
      }

      const isFirstTurn = messages.length === 0;
      const textToSend = isFirstTurn
        ? `[SYSTEM]${effectiveSystemAddendum}[/SYSTEM]\n\n${raw}`
        : raw;
      const routingMetadata =
        conversationAdapter?.buildRoutingMetadata?.() ??
        buildPageScopedRoutingMetadata(scope, {
          pageId,
          sourceConversationId,
        });
      const metadata = mergeConnectorSendAsMetadata(
        routingMetadata,
        sendAsMetadata,
      );

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
          metadata,
        );
        if (response.text && response.text !== streamed) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, text: response.text } : m,
            ),
          );
        }
        conversationAdapter?.onAfterSend?.();
        setAccountRequiredReason(null);
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        if (isLikelyAccountRequiredError(error)) {
          setAccountRequiredReason(
            error instanceof Error
              ? error.message
              : "Choose a connector account before sending.",
          );
        }
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
      blockingAccountReason,
      effectiveSystemAddendum,
      input,
      messages.length,
      pageId,
      pendingImages,
      conversationAdapter,
      scope,
      sendAsMetadata,
      sending,
      showWriteConfirmation,
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

  const hasClearableContent =
    messages.length > 0 ||
    input.trim().length > 0 ||
    pendingImages.length > 0 ||
    voice.isListening ||
    voicePreview.trim().length > 0;

  useEffect(() => {
    const handlePrefill = (event: Event) => {
      const detail = readChatPrefillDetail(event);
      if (!detail) return;
      if (voice.isListening) {
        void voice.stopListening();
        setVoicePreview("");
      }
      setInput(detail.text ?? "");
      window.requestAnimationFrame(() => {
        composerRef.current?.focus();
        if (detail.select) {
          composerRef.current?.select();
        }
      });
    };

    window.addEventListener(CHAT_PREFILL_EVENT, handlePrefill);
    return () => {
      window.removeEventListener(CHAT_PREFILL_EVENT, handlePrefill);
    };
  }, [voice.isListening, voice.stopListening]);

  const handleInputChange = useCallback(
    (value: string) => {
      if (voice.isListening) {
        void voice.stopListening();
        setVoicePreview("");
      }
      setInput(value);
    },
    [voice.isListening, voice.stopListening],
  );

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

  const handleClearConversation = useCallback(async () => {
    if (conversationAdapter?.allowClear === false) return;
    if (clearing || (!conversation && !hasClearableContent)) return;

    abortRef.current?.abort();
    if (voice.isListening) {
      void voice.stopListening();
    }

    setClearing(true);
    setLoadError(null);

    try {
      const nextConversation = await resetPageScopedConversation({
        scope,
        title,
        pageId,
      });
      setConversation(nextConversation);
      setMessages([]);
      setInput("");
      setPendingImages([]);
      setAttachmentError(null);
      setImageDragOver(false);
      setVoicePreview("");
      setSending(false);
      setFirstTokenReceived(false);
      setLoadError(null);
      setAccountRequiredReason(null);
      setPendingWriteConfirmationKey(null);
      window.requestAnimationFrame(() => {
        composerRef.current?.focus();
      });
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Failed to clear page chat.";
      setLoadError(message);
    } finally {
      setClearing(false);
    }
  }, [
    clearing,
    conversation,
    conversationAdapter,
    hasClearableContent,
    pageId,
    scope,
    title,
    voice.isListening,
    voice.stopListening,
  ]);

  const showIntro = messages.length === 0 && !sending && !persistentIntro;
  const showClearButton = conversationAdapter?.allowClear !== false;
  const introCard = (
    <div
      data-testid={`page-scoped-chat-intro-${scope}`}
      className="rounded-2xl bg-card/50 p-3"
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
  );

  const composerT = useCallback(
    (key: string, options?: Record<string, unknown>) => {
      const fallback =
        typeof options?.defaultValue === "string" ? options.defaultValue : key;

      switch (key) {
        case "aria.attachImage":
        case "chatview.AttachImage":
          return "Add attachment";
        case "chat.agentStarting":
          return "Agent starting";
        case "chat.inputPlaceholder":
        case "chat.inputPlaceholderNarrow":
        case "common.message":
          return placeholder;
        case "chat.listening":
          return "Listening…";
        case "chat.micTitleIdleEnhanced":
        case "chat.micTitleIdleStandard":
          return "Start voice input";
        case "chat.releaseToSend":
          return "Release to send";
        case "chat.send":
        case "common.send":
          return "Send";
        case "chat.stopGeneration":
          return "Stop";
        case "chat.stopListening":
          return "Stop voice input";
        case "chat.stopSpeaking":
          return "Stop";
        case "chat.voiceInput":
          return "Voice input";
        default:
          return fallback;
      }
    },
    [placeholder],
  );

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
      {persistentIntro ? <div className="px-3 pt-3">{introCard}</div> : null}
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

        {showIntro ? introCard : null}

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

      <div className="px-2 py-1.5">
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
        <ConnectorAccountPicker
          accounts={sendAsAccounts}
          className="mb-1"
          connectBusy={sendAsConnectBusy}
          loading={sendAsLoading}
          selectedAccount={sendAsSelectedAccount}
          sourceLabel={sourceLabel}
          show={showSendAsPicker}
          onConnectAccount={handleConnectSendAsAccount}
          onReconnectAccount={handleReconnectSendAsAccount}
          onSelectAccount={handleSelectSendAsAccount}
        />
        {blockingAccountReason ? (
          <AccountRequiredCard
            accounts={sendAsAccounts}
            className="mb-1"
            connectBusy={sendAsConnectBusy}
            description={blockingAccountReason}
            loading={sendAsLoading}
            selectedAccount={sendAsSelectedAccount}
            sourceLabel={sourceLabel}
            onConnectAccount={handleConnectSendAsAccount}
            onReconnectAccount={handleReconnectSendAsAccount}
            onSelectAccount={handleSelectSendAsAccount}
          />
        ) : showWriteConfirmation ? (
          <AccountRequiredCard
            accounts={sendAsAccounts}
            className="mb-1"
            connectBusy={sendAsConnectBusy}
            confirmLabel="Confirm send-as"
            description={`First send with ${sendAsSelectedAccount ? connectorAccountDisplayName(sendAsSelectedAccount) : "this account"} in ${sourceLabel}. Confirm before Eliza writes through it.`}
            loading={sendAsLoading}
            selectedAccount={sendAsSelectedAccount}
            sourceLabel={sourceLabel}
            title="Confirm send-as account"
            onConfirm={handleConfirmWriteAccount}
            onConnectAccount={handleConnectSendAsAccount}
            onReconnectAccount={handleReconnectSendAsAccount}
            onSelectAccount={handleSelectSendAsAccount}
          />
        ) : null}
        <div data-testid={`page-scoped-chat-composer-${scope}`}>
          <ChatComposer
            variant="default"
            layout="inline"
            textareaRef={composerRef}
            textareaAriaLabel={copy.title}
            chatInput={input}
            chatPendingImagesCount={pendingImages.length}
            isComposerLocked={disabled || sending}
            isAgentStarting={false}
            chatSending={sending}
            voice={{
              supported: voice.supported,
              isListening: voice.isListening,
              captureMode: voice.captureMode,
              interimTranscript: voicePreview,
              isSpeaking: voice.isSpeaking,
              assistantTtsQuality: voice.assistantTtsQuality,
              toggleListening: voice.toggleListening,
              startListening: voice.startListening,
              stopListening: voice.stopListening,
            }}
            agentVoiceEnabled={false}
            showAgentVoiceToggle={false}
            t={composerT}
            placeholder={placeholder}
            onAttachImage={() => fileInputRef.current?.click()}
            onChatInputChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onSend={() => void handleSend()}
            onStop={handleStop}
            onStopSpeaking={() => {}}
            onToggleAgentVoice={() => {}}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 px-1">
          {showClearButton ? (
            <button
              type="button"
              data-testid={`page-scoped-chat-clear-${scope}`}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:text-txt disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void handleClearConversation()}
              disabled={clearing || (!conversation && !hasClearableContent)}
              aria-label={clearing ? "Clearing page chat" : "Clear page chat"}
            >
              {clearing ? (
                <Spinner size={10} className="text-muted" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              <span>{clearing ? "Clearing…" : "Clear"}</span>
            </button>
          ) : (
            <div />
          )}
          {footerActions ? (
            <div className="flex items-center gap-1">{footerActions}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
