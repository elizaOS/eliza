import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import { Messages } from "@elizaos/capacitor-messages";
import { System, type SystemStatus } from "@elizaos/capacitor-system";
import type { OverlayAppContext } from "@elizaos/ui";
import { Button, Input, Textarea } from "@elizaos/ui";
import {
  ArrowLeft,
  ChevronLeft,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type ThreadSummary = {
  id: string;
  address: string;
  messages: SmsMessageSummary[];
  lastMessage: SmsMessageSummary;
  unreadCount: number;
};

const INBOUND_SMS_TYPE = 1;
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

function buildThreads(messages: SmsMessageSummary[]): ThreadSummary[] {
  const byThread = new Map<string, SmsMessageSummary[]>();
  for (const message of messages) {
    const key = message.threadId || message.address || message.id;
    const list = byThread.get(key) ?? [];
    list.push(message);
    byThread.set(key, list);
  }
  return Array.from(byThread.entries())
    .map(([id, threadMessages]) => {
      const sorted = [...threadMessages].sort((a, b) => a.date - b.date);
      const lastMessage = sorted[sorted.length - 1] ?? threadMessages[0];
      return {
        id,
        address: lastMessage?.address ?? "Unknown",
        messages: sorted,
        lastMessage,
        unreadCount: sorted.filter(
          (m) => !m.read && m.type === INBOUND_SMS_TYPE,
        ).length,
      };
    })
    .filter((thread): thread is ThreadSummary => Boolean(thread.lastMessage))
    .sort((a, b) => b.lastMessage.date - a.lastMessage.date);
}

function smsRole(status: SystemStatus | null) {
  return status?.roles.find((role) => role.role === "sms") ?? null;
}

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
      const [messageResult, statusResult] = await Promise.all([
        Messages.listMessages({ limit: 200 }),
        System.getStatus().catch(() => null),
      ]);
      setMessages(messageResult.messages);
      setSystemStatus(statusResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const threads = useMemo(() => buildThreads(messages), [messages]);
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const currentSmsRole = smsRole(systemStatus);
  const ownsSmsRole = currentSmsRole?.held === true;
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

  return (
    <div
      data-testid="messages-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/24 bg-bg/90 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-lg text-muted hover:text-txt"
            onClick={showComposer ? backToThreads : exitToApps}
            aria-label={
              showComposer
                ? t("messages.backToThreads", {
                    defaultValue: "Back to threads",
                  })
                : t("nav.back", { defaultValue: "Back" })
            }
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
            <p className="truncate text-xs text-muted">
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
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg text-muted hover:text-txt"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t("actions.refresh", { defaultValue: "Refresh" })}
            data-testid="messages-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="default"
            size="sm"
            className="rounded-lg"
            onClick={openNewComposer}
            data-testid="messages-new"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("messages.newShort", { defaultValue: "New" })}
          </Button>
        </div>
      </header>

      {currentSmsRole && !ownsSmsRole ? (
        <div className="shrink-0 border-b border-border/24 bg-bg-accent/40 px-4 py-3">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3 text-sm">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="font-medium text-txt">
                  {t("messages.smsRoleTitle", {
                    defaultValue: "SMS role is not assigned to this app",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {t("messages.smsRoleBody", {
                    defaultValue:
                      "Reading and sending real SMS requires Android to grant the default SMS role.",
                  })}
                </div>
              </div>
            </div>
            <Button
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

      {(error || notice) && (
        <div className="shrink-0 px-4 pt-3">
          <div
            role={error ? "alert" : "status"}
            className={`mx-auto max-w-5xl rounded-lg border px-3 py-2 text-sm ${
              error
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-border/30 bg-bg-accent text-muted"
            }`}
          >
            {error ?? notice}
          </div>
        </div>
      )}

      <main className="grid min-h-0 flex-1 md:grid-cols-[340px_minmax(0,1fr)]">
        <section
          className={`min-h-0 flex-col border-border/24 md:flex md:border-r ${
            showComposer ? "hidden" : "flex"
          }`}
          data-testid="messages-thread-list"
        >
          {loading && threads.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4 text-sm text-muted">
              {t("messages.loading", { defaultValue: "Loading messages…" })}
            </div>
          ) : threads.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <MessageSquareText className="h-11 w-11 text-muted" />
              <div>
                <div className="text-sm font-medium text-txt">
                  {t("messages.emptyTitle", {
                    defaultValue: "No SMS threads yet",
                  })}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {t("messages.emptyBody", {
                    defaultValue:
                      "Start a message, or grant SMS permissions on Android to load existing conversations.",
                  })}
                </p>
              </div>
              <Button size="sm" onClick={openNewComposer}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t("messages.new", { defaultValue: "New message" })}
              </Button>
            </div>
          ) : (
            <div className="chat-native-scrollbar min-h-0 flex-1 overflow-y-auto">
              {threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => openThread(thread)}
                  className="flex w-full items-start gap-3 border-b border-border/16 px-4 py-3 text-left transition-colors hover:bg-bg-accent/50 focus:bg-bg-accent/50 focus:outline-none"
                  data-testid={`messages-thread-${thread.id}`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg-accent">
                    <Smartphone className="h-4 w-4 text-muted" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-txt">
                        {thread.address || "Unknown"}
                      </span>
                      <span className="shrink-0 text-2xs text-muted">
                        {formatTime(thread.lastMessage.date)}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-xs text-muted">
                      {thread.lastMessage.body}
                    </span>
                  </span>
                  {thread.unreadCount > 0 ? (
                    <span className="rounded-full bg-info px-1.5 py-0.5 text-2xs font-semibold text-bg">
                      {thread.unreadCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </section>

        <section
          className={`min-h-0 flex-col ${showComposer ? "flex" : "hidden md:flex"}`}
          data-testid="messages-composer-panel"
        >
          {showComposer ? (
            <>
              <div className="shrink-0 border-b border-border/24 px-4 py-3">
                <label
                  htmlFor="messages-compose-address"
                  className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted"
                >
                  {t("messages.to", { defaultValue: "To" })}
                </label>
                <Input
                  id="messages-compose-address"
                  value={composeAddress}
                  onChange={(event) => setComposeAddress(event.target.value)}
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
                            className={`max-w-[78%] rounded-lg px-3 py-2 ${
                              sent ? "bg-info text-bg" : "bg-bg-accent text-txt"
                            }`}
                          >
                            <div className="whitespace-pre-wrap break-words text-sm">
                              {message.body}
                            </div>
                            <div
                              className={`mt-1 text-right text-2xs ${
                                sent ? "text-bg/70" : "text-muted"
                              }`}
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
                      <p className="mt-1 text-xs text-muted">
                        {t("messages.composeBody", {
                          defaultValue:
                            "Enter a phone number and message body. Android handles carrier delivery through the SMS bridge.",
                        })}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="shrink-0 border-t border-border/24 bg-bg/95 px-4 py-3">
                <div className="mx-auto flex max-w-2xl items-end gap-2">
                  <Textarea
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
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-lg"
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
                <p className="mt-1 text-xs text-muted">
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
