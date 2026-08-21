/**
 * Telegram Bot cloud connector (token-credential).
 *
 * Raw `fetch` connect/disconnect calls are swapped for the cloud {@link api}
 * client so the steward Bearer token is injected on native targets. The
 * "Next: Start chatting" callout `tone="blue"` is fixed to neutral `tone="muted"`.
 */

"use client";

import { Bot, ExternalLink, Loader2, MessageSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
  ConnectionInstructions,
} from "../../cloud-ui/components/connection-card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ApiError, api } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import { useConnectionStatus } from "./use-connection-status";

interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  botUsername?: string;
  botId?: number;
  error?: string;
}

interface TelegramConnectResponse {
  success?: boolean;
  botUsername?: string;
  error?: string;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body && typeof body === "object" && "error" in body) {
      const apiError = (body as { error?: unknown }).error;
      if (typeof apiError === "string" && apiError) return apiError;
    }
    return error.message || fallback;
  }
  return fallback;
}

export function TelegramConnection() {
  const t = useCloudT();
  const {
    status,
    isLoading,
    isError: isStatusError,
    errorMessage: statusErrorMessage,
    refetch: fetchStatus,
  } = useConnectionStatus<TelegramStatus>(
    "/api/v1/telegram/status",
    t("cloud.telegram.statusFetchFailed", {
      defaultValue: "Failed to fetch Telegram status",
    }),
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);

  const handleConnect = async () => {
    if (isConnecting) return;
    if (!botToken.trim()) {
      toast.error(
        t("cloud.telegram.enterBotToken", {
          defaultValue: "Please enter a bot token",
        }),
      );
      return;
    }

    setIsConnecting(true);

    try {
      const data = await api<TelegramConnectResponse>(
        "/api/v1/telegram/connect",
        { method: "POST", json: { botToken } },
      );

      if (data.success) {
        toast.success(
          t("cloud.telegram.connected", {
            username: data.botUsername,
            defaultValue: "Telegram bot @{{username}} connected!",
          }),
        );
        setBotToken("");
        void fetchStatus();
      } else {
        toast.error(
          data.error ||
            t("cloud.telegram.connectFailed", {
              defaultValue: "Failed to connect bot",
            }),
        );
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? apiErrorMessage(
              error,
              t("cloud.telegram.connectFailed", {
                defaultValue: "Failed to connect bot",
              }),
            )
          : t("cloud.telegram.networkError", {
              defaultValue: "Network error. Please check your connection.",
            }),
      );
    }

    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);

    try {
      await api("/api/v1/telegram/disconnect", { method: "DELETE" });
      toast.success(
        t("cloud.telegram.disconnected", {
          defaultValue: "Telegram bot disconnected",
        }),
      );
      void fetchStatus();
    } catch (error) {
      toast.error(
        apiErrorMessage(
          error,
          t("cloud.telegram.disconnectFailed", {
            defaultValue: "Failed to disconnect",
          }),
        ),
      );
    }

    setIsDisconnecting(false);
  };

  if (isLoading) {
    return (
      <ConnectionCard
        name={t("cloud.telegram.cardName", { defaultValue: "Telegram Bot" })}
        icon={<MessageSquare className="text-txt" />}
        description={t("cloud.telegram.cardDescription", {
          defaultValue: "Connect your Telegram bot for AI-powered automation",
        })}
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name={t("cloud.telegram.cardName", { defaultValue: "Telegram Bot" })}
      icon={<MessageSquare className="text-txt" />}
      description={t("cloud.telegram.cardDescription", {
        defaultValue: "Connect your Telegram bot for AI-powered automation",
      })}
      status={
        isStatusError
          ? "error"
          : status?.connected
            ? "connected"
            : "disconnected"
      }
      errorMessage={
        statusErrorMessage ??
        t("cloud.telegram.statusFetchFailed", {
          defaultValue: "Failed to fetch Telegram status",
        })
      }
      onRetry={() => void fetchStatus()}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Bot className="h-6 w-6 text-txt-strong" />}
            iconClassName="bg-accent"
            title={`@${status?.botUsername}`}
            subtitle={`Bot ID: ${status?.botId}`}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  window.open(`https://t.me/${status?.botUsername}`, "_blank")
                }
              >
                <ExternalLink className="h-4 w-4 mr-1" />
                {t("cloud.telegram.openBot", { defaultValue: "Open Bot" })}
              </Button>
            }
          >
            {status?.error && (
              <div className="text-sm text-yellow-600 mt-1">{status.error}</div>
            )}
          </ConnectionIdentityPanel>

          <ConnectionCallout
            title={t("cloud.telegram.nextTitle", {
              defaultValue: "Next: Start chatting with your bot",
            })}
            tone="muted"
          >
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>
                {t("cloud.telegram.nextStep1", {
                  username: status?.botUsername ?? "",
                  defaultValue: "Open Telegram and search for @{{username}}",
                })}
              </li>
              <li>
                {t("cloud.telegram.nextStep2", {
                  defaultValue: 'Click "Start" to begin a conversation',
                })}
              </li>
              <li>
                {t("cloud.telegram.nextStep3", {
                  defaultValue: "Send a message - your AI agent will respond",
                })}
              </li>
            </ol>
          </ConnectionCallout>

          <ConnectionFooterActions
            note={t("cloud.telegram.footerNote", {
              defaultValue: "Chats are auto-detected when bot is added.",
            })}
          >
            <ConnectionDisconnectAction
              title={t("cloud.telegram.disconnectTitle", {
                defaultValue: "Disconnect Telegram Bot?",
              })}
              description={t("cloud.telegram.disconnectDescription", {
                defaultValue:
                  "This will remove your bot credentials. Any active Telegram automation will stop working until you reconnect.",
              })}
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          </ConnectionFooterActions>
        </div>
      }
      setupContent={
        <div className="space-y-4">
          <ConnectionInstructions
            title={t("cloud.telegram.instructionsTitle", {
              defaultValue: "How to create a Telegram bot",
            })}
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                {t("cloud.telegram.instructSearch", {
                  defaultValue: "Open Telegram and search for",
                })}{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  @BotFather
                </a>
              </li>
              <li>
                {t("cloud.telegram.instructSendBefore", {
                  defaultValue: "Send",
                })}{" "}
                <code className="bg-background px-1 rounded-sm">/newbot</code>{" "}
                {t("cloud.telegram.instructSendAfter", {
                  defaultValue: "command",
                })}
              </li>
              <li>
                {t("cloud.telegram.instructName", {
                  defaultValue:
                    'Choose a name for your bot (e.g., "My App Bot")',
                })}
              </li>
              <li>
                {t("cloud.telegram.instructUsername", {
                  defaultValue:
                    'Choose a username ending in "bot" (e.g., "myapp_bot")',
                })}
              </li>
              <li>
                {t("cloud.telegram.instructCopyBefore", {
                  defaultValue: "Copy the",
                })}{" "}
                <strong>
                  {t("cloud.telegram.instructCopyToken", {
                    defaultValue: "API token",
                  })}
                </strong>{" "}
                {t("cloud.telegram.instructCopyAfter", {
                  defaultValue: "BotFather gives you",
                })}
              </li>
              <li>
                {t("cloud.telegram.instructPaste", {
                  defaultValue: "Paste the token below",
                })}
              </li>
            </ol>
          </ConnectionInstructions>

          <div className="space-y-2">
            <Label htmlFor="botToken">
              {t("cloud.telegram.botTokenLabel", { defaultValue: "Bot Token" })}
            </Label>
            <Input
              id="botToken"
              type="password"
              placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
            />
            <p className="text-xs text-muted-foreground">
              {t("cloud.telegram.botTokenHint", {
                defaultValue:
                  "Get this from @BotFather after creating your bot",
              })}
            </p>
          </div>

          <div className="p-4 bg-muted rounded-sm">
            <h4 className="font-medium mb-2">
              {t("cloud.telegram.whatYouCanDo", {
                defaultValue: "What you can do with Telegram automation:",
              })}
            </h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                {t("cloud.telegram.capability1", {
                  defaultValue: "• Post AI-generated announcements to channels",
                })}
              </li>
              <li>
                {t("cloud.telegram.capability2", {
                  defaultValue: "• Auto-reply to messages in groups",
                })}
              </li>
              <li>
                {t("cloud.telegram.capability3", {
                  defaultValue: "• Welcome new members with custom messages",
                })}
              </li>
              <li>
                {t("cloud.telegram.capability4", {
                  defaultValue: "• Handle commands like /help and /about",
                })}
              </li>
            </ul>
          </div>

          <Button
            onClick={handleConnect}
            disabled={isConnecting || !botToken.trim()}
            className="w-full"
          >
            {isConnecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t("cloud.telegram.connecting", {
                  defaultValue: "Connecting...",
                })}
              </>
            ) : (
              <>
                <MessageSquare className="h-4 w-4 mr-2" />
                {t("cloud.telegram.connectButton", {
                  defaultValue: "Connect Telegram Bot",
                })}
              </>
            )}
          </Button>
        </div>
      }
    />
  );
}
