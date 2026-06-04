import {
  BrandButton,
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/ui";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import type { AgentDetailDto } from "@/lib/types/cloud-api";
import { useT } from "@/providers/I18nProvider";
import { openWebUIWithPairing } from "../../../../hooks/open-web-ui";
import { ApiError, api } from "../../../../lib/api-client";
import { useRequireAuth } from "../../../../lib/auth-hooks";
import { useAgent } from "../../../../lib/data/eliza-agents";

type ChatRole = "user" | "agent" | "system";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

interface BridgeError {
  code?: number;
  message: string;
}

interface BridgeMessageResult {
  text?: string;
  response?: string;
  message?: string;
  agentName?: string;
  channelId?: string;
  runtime?: string;
  ready?: boolean;
  chat?: boolean;
}

interface BridgeEnvelope {
  jsonrpc: "2.0";
  id?: string | number;
  result?: BridgeMessageResult;
  error?: BridgeError;
}

type BridgeState = "idle" | "checking" | "ready" | "error";

function getErrorMessage(error: Error): string {
  if (error instanceof ApiError) return error.message;
  return error.message;
}

function displayName(agent: AgentDetailDto): string {
  const name = agent.agentName;
  if (name && name.trim().length > 0) return name;
  return agent.id.slice(0, 8);
}

function bridgeReplyText(
  result: BridgeMessageResult | undefined,
): string | null {
  if (!result) return null;
  if (typeof result.text === "string" && result.text.trim().length > 0) {
    return result.text;
  }
  if (
    typeof result.response === "string" &&
    result.response.trim().length > 0
  ) {
    return result.response;
  }
  if (typeof result.message === "string" && result.message.trim().length > 0) {
    return result.message;
  }
  return null;
}

function AgentBridgeChat({ agent }: { agent: AgentDetailDto }) {
  const t = useT();
  const name = useMemo(() => displayName(agent), [agent]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [bridgeState, setBridgeState] = useState<BridgeState>("idle");
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [chatAvailable, setChatAvailable] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isRunning = agent.status === "running";
  const hasWebUi = Boolean(agent.webUiUrl);
  const canUseBridgeChat = isRunning && chatAvailable;

  useEffect(() => {
    if (messages.length === 0 && !isSending) return;
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [isSending, messages.length]);

  const postBridge = useCallback(
    (method: "status.get" | "message.send", params: Record<string, string>) =>
      api<BridgeEnvelope>(`/api/v1/eliza/agents/${agent.id}/bridge`, {
        method: "POST",
        json: {
          jsonrpc: "2.0",
          id: `${method}-${Date.now()}`,
          method,
          params,
        },
      }),
    [agent.id],
  );

  const checkBridge = useCallback(async () => {
    if (!isRunning) return;
    setBridgeState("checking");
    setBridgeError(null);
    try {
      const response = await postBridge("status.get", {});
      if (response.error) throw new Error(response.error.message);
      setChatAvailable(response.result?.chat !== false);
      setBridgeState("ready");
    } catch (error) {
      const message = getErrorMessage(
        error instanceof Error ? error : new Error(String(error)),
      );
      setChatAvailable(true);
      setBridgeState("error");
      setBridgeError(message);
    }
  }, [isRunning, postBridge]);

  useEffect(() => {
    void checkBridge();
  }, [checkBridge]);

  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isSending || !canUseBridgeChat) return;

    const requestId = Date.now();
    const userMessage: ChatMessage = {
      id: `user-${requestId}`,
      role: "user",
      text,
    };

    setMessages((current) => [...current, userMessage]);
    setInputText("");
    setIsSending(true);
    setBridgeError(null);

    try {
      const response = await postBridge("message.send", {
        text,
        userId: "dashboard",
        roomId: `dashboard-${agent.id}`,
      });
      if (response.error) throw new Error(response.error.message);
      const reply = bridgeReplyText(response.result);
      if (!reply) throw new Error("Agent returned an empty response");

      setMessages((current) => [
        ...current,
        {
          id: `agent-${Date.now()}`,
          role: "agent",
          text: reply,
        },
      ]);
      setBridgeState("ready");
    } catch (error) {
      const message = getErrorMessage(
        error instanceof Error ? error : new Error(String(error)),
      );
      setBridgeState("error");
      setBridgeError(message);
      setMessages((current) => [
        ...current,
        {
          id: `system-${Date.now()}`,
          role: "system",
          text: message,
        },
      ]);
      toast.error(message);
    } finally {
      setIsSending(false);
    }
  }, [agent.id, canUseBridgeChat, inputText, isSending, postBridge]);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link
        to={`/dashboard/agents/${agent.id}`}
        className="group inline-flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors"
      >
        <div className="flex items-center justify-center w-7 h-7 bg-black/40 group-hover:bg-white/10 transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" />
        </div>
        <span>
          {t("cloud.agents.chat.backToAgent", {
            defaultValue: "Back to agent",
          })}
        </span>
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-[#FF5800]/25 bg-[#FF5800]/10">
            <MessageCircle className="h-5 w-5 text-[#FF5800]" />
          </div>
          <div className="min-w-0">
            <h1
              className="truncate text-xl font-semibold text-white"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {t("cloud.agents.chat.titleWithName", {
                defaultValue: "Chat — {{name}}",
                name,
              })}
            </h1>
            <p className="truncate font-mono text-xs text-white/40">
              {agent.id}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BrandButton
            variant="outline"
            size="sm"
            onClick={checkBridge}
            disabled={!isRunning || bridgeState === "checking"}
          >
            {bridgeState === "checking" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("cloud.agents.chat.refresh", { defaultValue: "Refresh" })}
          </BrandButton>
          {hasWebUi && isRunning && (
            <BrandButton
              variant="primary"
              size="sm"
              onClick={() => openWebUIWithPairing(agent.id)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("cloud.agents.chat.openWebUi", {
                defaultValue: "Open web UI",
              })}
            </BrandButton>
          )}
        </div>
      </div>

      <div className="border border-white/10 bg-black">
        <div className="flex min-h-[420px] flex-col">
          {!isRunning && (
            <div className="border-b border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-200/80">
              {t("cloud.agents.chat.agentIsStatus", {
                defaultValue: "This agent is",
              })}{" "}
              <span className="font-mono">{agent.status}</span>.{" "}
              {t("cloud.agents.chat.startBeforeChat", {
                defaultValue: "Start the agent before chatting.",
              })}
            </div>
          )}

          {bridgeError && isRunning && (
            <div className="border-b border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-200/80">
              {bridgeError}
            </div>
          )}

          {chatAvailable === false && isRunning && (
            <div className="border-b border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/60">
              {t("cloud.agents.chat.webOnly", {
                defaultValue:
                  "This custom app is online. Chat is handled by its Web UI.",
              })}
            </div>
          )}

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[280px] items-center justify-center text-center text-sm text-white/35">
                {chatAvailable === false && isRunning
                  ? t("cloud.agents.chat.emptyWebOnly", {
                      defaultValue:
                        "Open the Web UI to interact with this app.",
                    })
                  : isRunning
                    ? t("cloud.agents.chat.emptyReady", {
                        defaultValue: "Send a message to start this session.",
                      })
                    : t("cloud.agents.chat.emptyStopped", {
                        defaultValue:
                          "Agent chat is unavailable while stopped.",
                      })}
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap border px-3 py-2 text-sm leading-6 ${
                      message.role === "user"
                        ? "border-[#FF5800]/35 bg-[#FF5800]/10 text-white"
                        : message.role === "agent"
                          ? "border-white/10 bg-white/[0.04] text-white/90"
                          : "border-red-500/20 bg-red-500/5 text-red-200/80"
                    }`}
                  >
                    {message.text}
                  </div>
                </div>
              ))
            )}
            {isSending && (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/55">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("cloud.agents.chat.waiting", {
                    defaultValue: "Waiting for reply",
                  })}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form
            className="border-t border-white/10 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <div className="flex gap-2">
              <textarea
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                disabled={!canUseBridgeChat || isSending}
                rows={2}
                placeholder={
                  chatAvailable === false
                    ? t("cloud.agents.chat.webOnlyPlaceholder", {
                        defaultValue: "Open the Web UI to interact",
                      })
                    : t("cloud.agents.chat.placeholder", {
                        defaultValue: "Message this agent",
                      })
                }
                className="min-h-12 flex-1 resize-none border border-white/10 bg-black px-3 py-2 text-sm leading-6 text-white outline-none transition-colors placeholder:text-white/25 focus:border-[#FF5800]/60 disabled:cursor-not-allowed disabled:text-white/30"
              />
              <BrandButton
                type="submit"
                variant="primary"
                size="sm"
                disabled={
                  !canUseBridgeChat ||
                  isSending ||
                  inputText.trim().length === 0
                }
                className="h-auto self-stretch px-3"
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span className="sr-only">
                  {t("cloud.agents.chat.send", { defaultValue: "Send" })}
                </span>
              </BrandButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function AgentChatPage() {
  const t = useT();
  const session = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const enabled = session.ready && session.authenticated;
  const query = useAgent(enabled ? id : undefined);

  const titleId = id ? id.slice(0, 8) : "";

  if (!session.ready || (enabled && query.isLoading)) {
    return (
      <>
        <Helmet>
          <title>
            {t("cloud.agents.chat.metaTitleLoading", {
              defaultValue: "Chat {{id}} — Agent",
              id: titleId,
            })}
          </title>
        </Helmet>
        <DashboardLoadingState
          label={t("cloud.agents.chat.loading", {
            defaultValue: "Loading agent",
          })}
        />
      </>
    );
  }

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <Navigate to="/dashboard/agents" replace />;
  }
  if (query.error) {
    const msg =
      query.error instanceof Error
        ? query.error.message
        : t("cloud.agents.chat.errorFailedLoad", {
            defaultValue: "Failed to load agent",
          });
    return <DashboardErrorState message={msg} />;
  }

  const agent = query.data;
  if (!agent) return <Navigate to="/dashboard/agents" replace />;

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.agents.chat.metaTitle", {
            defaultValue: "Chat — {{name}}",
            name: displayName(agent),
          })}
        </title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <AgentBridgeChat agent={agent} />
    </>
  );
}
