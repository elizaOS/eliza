"use client";

import {
  Button,
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
  ConnectionInstructions,
  Input,
  Label,
} from "@elizaos/ui";
import { Bot, ExternalLink, Loader2, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  botUsername?: string;
  botId?: number;
  error?: string;
}

export function TelegramConnection() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);

  const fetchStatus = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/v1/telegram/status", { signal });
      if (!signal?.aborted) {
        setStatus(await response.json());
      }
    } catch {
      if (!signal?.aborted) {
        toast.error("Failed to fetch Telegram status");
      }
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchStatus(controller.signal);
    return () => controller.abort();
  }, [fetchStatus]);

  const handleConnect = async () => {
    if (isConnecting) return;
    if (!botToken.trim()) {
      toast.error("Please enter a bot token");
      return;
    }

    setIsConnecting(true);

    try {
      const response = await fetch("/api/v1/telegram/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(`Telegram bot @${data.botUsername} connected!`);
        setBotToken("");
        void fetchStatus();
      } else {
        toast.error(data.error || "Failed to connect bot");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);

    try {
      const response = await fetch("/api/v1/telegram/disconnect", {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Telegram bot disconnected");
        void fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to disconnect");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setIsDisconnecting(false);
  };

  if (isLoading) {
    return (
      <ConnectionCard
        name="Telegram Bot"
        icon={<MessageSquare className="text-[#0088cc]" />}
        description="Connect your Telegram bot for AI-powered automation"
        status="loading"
      />
    );
  }

  return (
    <ConnectionCard
      name="Telegram Bot"
      icon={<MessageSquare className="text-[#0088cc]" />}
      description="Connect your Telegram bot for AI-powered automation"
      status={status?.connected ? "connected" : "disconnected"}
      statusBadge={<ConnectionConnectedBadge />}
      connectedContent={
        <div className="space-y-4">
          <ConnectionIdentityPanel
            icon={<Bot className="h-6 w-6 text-white" />}
            iconClassName="bg-[#0088cc]"
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
                Open Bot
              </Button>
            }
          >
            {status?.error && (
              <div className="text-sm text-yellow-600 mt-1">{status.error}</div>
            )}
          </ConnectionIdentityPanel>

          <ConnectionCallout
            title="Next: Start chatting with your bot"
            tone="blue"
          >
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Open Telegram and search for @{status?.botUsername}</li>
              <li>Click &quot;Start&quot; to begin a conversation</li>
              <li>Send a message - your AI agent will respond</li>
            </ol>
          </ConnectionCallout>

          <ConnectionFooterActions note="Chats are auto-detected when bot is added.">
            <ConnectionDisconnectAction
              title="Disconnect Telegram Bot?"
              description="This will remove your bot credentials. Any active Telegram automation will stop working until you reconnect."
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          </ConnectionFooterActions>
        </div>
      }
      setupContent={
        <div className="space-y-4">
          <ConnectionInstructions
            title="How to create a Telegram bot"
            open={showInstructions}
            onOpenChange={setShowInstructions}
          >
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>
                Open Telegram and search for{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#0088cc] hover:underline"
                >
                  @BotFather
                </a>
              </li>
              <li>
                Send <code className="bg-background px-1 rounded-sm">/newbot</code>{" "}
                command
              </li>
              <li>Choose a name for your bot (e.g., &quot;My App Bot&quot;)</li>
              <li>
                Choose a username ending in &quot;bot&quot; (e.g.,
                &quot;myapp_bot&quot;)
              </li>
              <li>
                Copy the <strong>API token</strong> BotFather gives you
              </li>
              <li>Paste the token below</li>
            </ol>
          </ConnectionInstructions>

          <div className="space-y-2">
            <Label htmlFor="botToken">Bot Token</Label>
            <Input
              id="botToken"
              type="password"
              placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
            />
            <p className="text-xs text-muted-foreground">
              Get this from @BotFather after creating your bot
            </p>
          </div>

          <div className="p-4 bg-muted rounded-sm">
            <h4 className="font-medium mb-2">
              What you can do with Telegram automation:
            </h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Post AI-generated announcements to channels</li>
              <li>• Auto-reply to messages in groups</li>
              <li>• Welcome new members with custom messages</li>
              <li>• Handle commands like /help and /about</li>
            </ul>
          </div>

          <Button
            onClick={handleConnect}
            disabled={isConnecting || !botToken.trim()}
            className="w-full bg-[#0088cc] hover:bg-[#0077b5]"
          >
            {isConnecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Connecting...
              </>
            ) : (
              <>
                <MessageSquare className="h-4 w-4 mr-2" />
                Connect Telegram Bot
              </>
            )}
          </Button>
        </div>
      }
    />
  );
}
