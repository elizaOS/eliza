import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import { Messages } from "@elizaos/capacitor-messages";
import { System, type SystemStatus } from "@elizaos/capacitor-system";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { consumePendingMessageRecipient } from "@elizaos/ui/app-navigate-view";
import { PermissionRecoveryCallout } from "@elizaos/ui/components";
import type { OverlayAppContext } from "@elizaos/ui/components/apps/overlay-app-api";
import { Button } from "@elizaos/ui/components/ui/button";
import { Input } from "@elizaos/ui/components/ui/input";
import { Textarea } from "@elizaos/ui/components/ui/textarea";
import {
  ArrowLeft,
  ChevronLeft,
  MessageSquareText,
  Plus,
  Send,
  ShieldCheck,
} from "lucide-react";
import {
  type ChangeEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  buildThreads,
  smsRole,
  type ThreadSummary,
} from "./MessagesAppView.helpers.ts";

const SENT_SMS_TYPE = 2;

function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function threadInitial(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) return "#";
  const firstLetter = trimmed.split("").find((ch) => /[a-z]/i.test(ch));
  if (firstLetter) return firstLetter.toUpperCase();
  const firstDigit = trimmed.replace(/[^0-9]/g, "").slice(-1);
  return firstDigit || "#";
}

function isMessagesPermissionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("permission") ||
    normalized.includes("denied") ||
    normalized.includes("access is needed") ||
    normalized.includes("read_sms") ||
    normalized.includes("send_sms")
  );
}

function StatChip({
  icon,
  label,
  accent = false,
}: {
  icon?: ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-1 py-1 text-xs font-medium"
      style={{
        color: accent ? "var(--accent)" : "var(--muted)",
      }}
    >
      {icon ? (
        <span
          aria-hidden
          className="flex h-3.5 w-3.5 items-center justify-center"
        >
          {icon}
        </span>
      ) : null}
      {label}
    </span>
  );
}

function ChatBubblesMotif() {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" role="img">
      <title>Chat bubbles</title>
      <rect
        x="10"
        y="20"
        width="56"
        height="34"
        rx="12"
        fill="var(--accent-subtle)"
        stroke="var(--accent)"
        strokeWidth="2"
      />
      <path d="M24 54 L24 64 L36 54 Z" fill="var(--accent-subtle)" />
      <rect
        x="38"
        y="44"
        width="48"
        height="30"
        rx="11"
        fill="var(--surface)"
        stroke="var(--border)"
        strokeWidth="2"
      />
      <path d="M72 74 L72 82 L62 74 Z" fill="var(--surface)" />
      <circle cx="24" cy="37" r="2.5" fill="var(--accent)" />
      <circle cx="34" cy="37" r="2.5" fill="var(--accent)" />
      <circle cx="44" cy="37" r="2.5" fill="var(--accent)" />
      <circle cx="56" cy="59" r="2.5" fill="var(--muted)" />
      <circle cx="66" cy="59" r="2.5" fill="var(--muted)" />
      <circle cx="76" cy="59" r="2.5" fill="var(--muted)" />
    </svg>
  );
}

const MessagesThreadButton = memo(function MessagesThreadButton({
  thread,
  selected,
  onOpen,
}: {
  thread: ThreadSummary;
  selected: boolean;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `thread-${thread.id}`,
    role: "list-item",
    label: thread.address || "Unknown",
    group: "messages-threads",
    status: selected ? "active" : undefined,
    description: `Open the SMS thread with ${thread.address || "Unknown"}`,
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      onClick={() => onOpen(thread)}
      aria-current={selected ? "true" : undefined}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors focus:outline-none"
      style={selected ? { background: "var(--accent-subtle)" } : undefined}
      data-testid={`messages-thread-${thread.id}`}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}
      >
        {threadInitial(thread.address)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-txt">
            {thread.address || "Unknown"}
          </span>
          <span className="shrink-0 px-1 py-0.5 text-2xs text-muted">
            {formatTime(thread.lastMessage.date)}
          </span>
        </span>
        <span className="mt-1 line-clamp-2 text-xs text-muted">
          {thread.lastMessage.body}
        </span>
      </span>
      {thread.unreadCount > 0 ? (
        <span
          className="rounded-full px-1.5 py-0.5 text-2xs font-semibold"
          style={{
            background: "var(--accent)",
            color: "var(--accent-foreground)",
          }}
        >
          {thread.unreadCount}
        </span>
      ) : null}
    </button>
  );
});

export function MessagesAppView({ exitToApps, t }: OverlayAppContext) {
  const [messages, setMessages] = useState<SmsMessageSummary[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composeAddress, setComposeAddress] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [requestingRole, setRequestingRole] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // System status (default-SMS role) loads regardless so the role banner
      // always shows. Reading/sending SMS via the bridge needs READ/SEND_SMS —
      // request it on first open (feature-gated; idempotent). Tolerates older
      // bridges without the request path by falling through to listMessages.
      const statusResult = await System.getStatus().catch(() => null);
      setSystemStatus(statusResult);
      const perm = await Messages.requestPermissions().catch(() => null);
      if (perm && perm.sms !== "granted") {
        setMessages([]);
        setError(
          "SMS access is needed to read and send messages. Grant it in your device settings, then retry.",
        );
        return;
      }
      const messageResult = await Messages.listMessages({ limit: 200 });
      setMessages(messageResult.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount, then quietly poll so newly received SMS surface without a
  // manual control. The bridge has no push channel, so a 20s interval keeps the
  // thread list fresh; it is cleared on unmount.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 20000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Seed the composer from a cross-view handoff (e.g. a Contacts "Message"
  // control that navigated here with a number). Single-shot: the recipient is
  // consumed so a later plain navigation to Messages does not re-seed a stale
  // "To" field.
  useEffect(() => {
    const pending = consumePendingMessageRecipient();
    if (pending) {
      setSelectedThreadId(null);
      setComposeAddress(pending);
      setComposeBody("");
      setShowComposer(true);
      setNotice(null);
      setError(null);
    }
  }, []);

  const threads = useMemo(() => buildThreads(messages), [messages]);
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const currentSmsRole = smsRole(systemStatus);
  const ownsSmsRole = currentSmsRole?.held === true;
  const unreadTotal = threads.reduce(
    (total, thread) => total + thread.unreadCount,
    0,
  );
  const canSend =
    composeAddress.trim().length > 0 &&
    composeBody.trim().length > 0 &&
    !sending;

  const openThread = useCallback((thread: ThreadSummary) => {
    setSelectedThreadId(thread.id);
    setComposeAddress(thread.address);
    setShowComposer(true);
    setNotice(null);
    setError(null);
  }, []);

  const openNewComposer = useCallback(() => {
    setSelectedThreadId(null);
    setComposeAddress("");
    setComposeBody("");
    setShowComposer(true);
    setNotice(null);
    setError(null);
  }, []);

  const backToThreads = useCallback(() => {
    setShowComposer(false);
    setSelectedThreadId(null);
  }, []);

  const requestSmsRole = useCallback(async () => {
    setRequestingRole(true);
    setError(null);
    try {
      await System.requestRole({ role: "sms" });
      const next = await System.getStatus();
      setSystemStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequestingRole(false);
    }
  }, []);

  const send = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await Messages.sendSms({
        address: composeAddress.trim(),
        body: composeBody.trim(),
      });
      setComposeBody("");
      setNotice("Message sent.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [canSend, composeAddress, composeBody, refresh]);

  const title = showComposer
    ? selectedThread?.address ||
      t("messages.new", { defaultValue: "New message" })
    : t("messages.title", { defaultValue: "Messages" });

  const backLabel = showComposer
    ? t("messages.backToThreads", { defaultValue: "Back to threads" })
    : t("nav.back", { defaultValue: "Back" });
  const back = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: backLabel,
    group: "messages-header",
    description: showComposer
      ? "Return from the composer to the thread list"
      : "Leave Messages and return to the apps grid",
  });
  const newMessage = useAgentElement<HTMLButtonElement>({
    id: "action-new-message",
    role: "button",
    label: t("messages.newShort", { defaultValue: "New" }),
    group: "messages-header",
    description: "Open the composer to start a new text message",
  });
  const emptyNewMessage = useAgentElement<HTMLButtonElement>({
    id: "action-empty-new-message",
    role: "button",
    label: t("messages.new", { defaultValue: "New message" }),
    group: "messages-threads",
    description: "Start a new text message from the empty thread list",
  });
  const requestRole = useAgentElement<HTMLButtonElement>({
    id: "action-set-default-sms",
    role: "button",
    label: t("messages.setDefaultSms", { defaultValue: "Set default SMS" }),
    group: "messages-sms-role",
    description: "Request the Android default SMS role for this app",
  });
  const addressInput = useAgentElement<HTMLInputElement>({
    id: "input-recipient",
    role: "text-input",
    label: t("messages.to", { defaultValue: "To" }),
    group: "messages-composer",
    description: "Recipient phone number for the outgoing text message",
    getValue: () => composeAddress,
    onFill: setComposeAddress,
  });
  const bodyInput = useAgentElement<HTMLTextAreaElement>({
    id: "input-message-body",
    role: "textarea",
    label: t("messages.placeholder", { defaultValue: "Message" }),
    group: "messages-composer",
    description: "Body text of the outgoing message",
    getValue: () => composeBody,
    onFill: setComposeBody,
  });
  const sendButton = useAgentElement<HTMLButtonElement>({
    id: "action-send",
    role: "button",
    label: t("messages.send", { defaultValue: "Send" }),
    group: "messages-composer",
    description: "Send the composed text message",
  });

  return (
    <div
      data-testid="messages-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            ref={back.ref}
            {...back.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted hover:text-txt"
            onClick={showComposer ? backToThreads : exitToApps}
            aria-label={backLabel}
          >
            {showComposer ? (
              <ChevronLeft className="h-4 w-4" />
            ) : (
              <ArrowLeft className="h-4 w-4" />
            )}
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt">
              {title}
            </h1>
            <p className="sr-only truncate text-xs text-muted">
              {ownsSmsRole
                ? t("messages.smsReady", { defaultValue: "Default SMS app" })
                : t("messages.smsBridge", {
                    defaultValue: "Android SMS bridge",
                  })}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            ref={newMessage.ref}
            {...newMessage.agentProps}
            variant="default"
            size="sm"
            className="px-3"
            onClick={openNewComposer}
            data-testid="messages-new"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("messages.newShort", { defaultValue: "New" })}
          </Button>
        </div>
      </header>

      {currentSmsRole && !ownsSmsRole ? (
        <div className="shrink-0 px-3 py-2">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3 text-sm">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="font-medium text-txt">
                  {t("messages.smsRoleTitle", {
                    defaultValue: "SMS role is not assigned to this app",
                  })}
                </div>
                <div className="sr-only text-xs text-muted">
                  {t("messages.smsRoleBody", {
                    defaultValue:
                      "Reading and sending real SMS requires Android to grant the default SMS role.",
                  })}
                </div>
              </div>
            </div>
            <Button
              ref={requestRole.ref}
              {...requestRole.agentProps}
              variant="outline"
              size="sm"
              onClick={requestSmsRole}
              disabled={requestingRole}
              data-testid="messages-request-sms-role"
            >
              {requestingRole
                ? t("messages.requesting", { defaultValue: "Requesting…" })
                : t("messages.setDefaultSms", {
                    defaultValue: "Set default SMS",
                  })}
            </Button>
          </div>
        </div>
      ) : null}

      {error && isMessagesPermissionError(error) ? (
        <div className="shrink-0 px-4 pt-3">
          <PermissionRecoveryCallout
            permission="messages"
            title={t("messages.permissionTitle", {
              defaultValue: "SMS access is off",
            })}
            description={error}
            onRetry={refresh}
            retryLabel={t("actions.retry", { defaultValue: "Try again" })}
            className="mx-auto max-w-5xl"
            testId="messages-permission-callout"
          />
        </div>
      ) : error || notice ? (
        <div className="shrink-0 px-4 pt-3">
          <div
            role={error ? "alert" : "status"}
            className={`mx-auto max-w-5xl px-1 py-2 text-sm ${
              error ? "text-danger" : "text-muted"
            }`}
          >
            {error ?? notice}
          </div>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col">
        <section
          className={`min-h-0 flex-1 flex-col ${
            showComposer ? "hidden" : "flex"
          }`}
          data-testid="messages-thread-list"
        >
          {loading && threads.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4 text-sm text-muted">
              {t("messages.loading", { defaultValue: "Loading messages…" })}
            </div>
          ) : threads.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 pb-32 text-center">
              <span
                className="flex h-20 w-20 items-center justify-center rounded-3xl"
                style={{ background: "var(--accent-subtle)" }}
              >
                <ChatBubblesMotif />
              </span>
              <h2 className="mt-5 text-base font-semibold text-txt">
                {t("messages.empty.title", { defaultValue: "No messages yet" })}
              </h2>
              <p className="sr-only mt-1 max-w-xs text-sm text-muted">
                {t("messages.empty.body", {
                  defaultValue:
                    "Start a conversation — texts you send and receive show up here.",
                })}
              </p>
              <div className="sr-only mt-4 flex flex-wrap items-center justify-center gap-2">
                <StatChip
                  label={t("messages.threadCount", {
                    defaultValue: "0 threads",
                  })}
                />
              </div>
              <button
                ref={emptyNewMessage.ref}
                {...emptyNewMessage.agentProps}
                type="button"
                onClick={openNewComposer}
                className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold transition-colors"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-foreground)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--accent-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--accent)";
                }}
              >
                <Plus className="h-4 w-4" />
                {t("messages.new", { defaultValue: "New message" })}
              </button>
            </div>
          ) : (
            <div className="chat-native-scrollbar min-h-0 flex-1 overflow-y-auto pb-32">
              <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                <StatChip
                  label={t("messages.threadCountN", {
                    defaultValue: `${threads.length} threads`,
                  })}
                />
                <StatChip
                  label={t("messages.unreadCountN", {
                    defaultValue: `${unreadTotal} unread`,
                  })}
                  accent={unreadTotal > 0}
                />
              </div>
              <div>
                {threads.map((thread) => (
                  <MessagesThreadButton
                    key={thread.id}
                    thread={thread}
                    selected={thread.id === selectedThreadId}
                    onOpen={openThread}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section
          className={`min-h-0 flex-1 flex-col ${showComposer ? "flex" : "hidden"}`}
          data-testid="messages-composer-panel"
        >
          {showComposer ? (
            <>
              <div className="shrink-0 px-3 py-2">
                <label
                  htmlFor="messages-compose-address"
                  className="text-xs text-muted"
                >
                  {t("messages.to", { defaultValue: "To" })}
                </label>
                <Input
                  ref={addressInput.ref}
                  {...addressInput.agentProps}
                  id="messages-compose-address"
                  value={composeAddress}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setComposeAddress(event.target.value)
                  }
                  placeholder="+1 555 123 4567"
                  inputMode="tel"
                  className="mt-1"
                  data-testid="messages-compose-address"
                />
              </div>

              <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4">
                {selectedThread ? (
                  <div className="mx-auto flex max-w-2xl flex-col gap-2">
                    {selectedThread.messages.map((message) => {
                      const sent = message.type === SENT_SMS_TYPE;
                      return (
                        <div
                          key={message.id}
                          className={`flex ${sent ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className="max-w-[78%] rounded-2xl px-3 py-2"
                            style={
                              sent
                                ? {
                                    background: "var(--accent)",
                                    color: "var(--accent-foreground)",
                                  }
                                : {
                                    background: "var(--surface)",
                                    color: "var(--text)",
                                  }
                            }
                          >
                            <div className="whitespace-pre-wrap break-words text-sm">
                              {message.body}
                            </div>
                            <div
                              className="mt-1 text-right text-2xs"
                              style={{
                                opacity: 0.7,
                                color: sent
                                  ? "var(--accent-foreground)"
                                  : "var(--muted)",
                              }}
                            >
                              {formatTime(message.date)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-center">
                    <div className="max-w-sm">
                      <MessageSquareText className="mx-auto h-12 w-12 text-muted" />
                      <div className="mt-3 text-sm font-medium text-txt">
                        {t("messages.composeTitle", {
                          defaultValue: "Start a text message",
                        })}
                      </div>
                      <p className="sr-only mt-1 text-xs text-muted">
                        {t("messages.composeBody", {
                          defaultValue:
                            "Enter a phone number and message body. Android handles carrier delivery through the SMS bridge.",
                        })}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="shrink-0 bg-bg/95 px-3 py-2">
                <div className="mx-auto flex max-w-2xl items-end gap-2">
                  <Textarea
                    ref={bodyInput.ref}
                    {...bodyInput.agentProps}
                    value={composeBody}
                    onChange={(event) => setComposeBody(event.target.value)}
                    placeholder={t("messages.placeholder", {
                      defaultValue: "Message",
                    })}
                    className="min-h-[44px] resize-none"
                    rows={2}
                    data-testid="messages-compose-body"
                  />
                  <Button
                    ref={sendButton.ref}
                    {...sendButton.agentProps}
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={() => void send()}
                    disabled={!canSend}
                    aria-label={t("messages.send", { defaultValue: "Send" })}
                    data-testid="messages-send"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div className="max-w-sm">
                <MessageSquareText className="mx-auto h-12 w-12 text-muted" />
                <div className="mt-3 text-sm font-medium text-txt">
                  {t("messages.selectTitle", {
                    defaultValue: "Select a conversation",
                  })}
                </div>
                <p className="sr-only mt-1 text-xs text-muted">
                  {t("messages.selectBody", {
                    defaultValue:
                      "Review existing SMS threads or start a new text message.",
                  })}
                </p>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
