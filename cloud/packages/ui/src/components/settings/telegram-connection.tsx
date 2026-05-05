"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
} from "@elizaos/cloud-ui";
import {
  Bot,
  CheckCircle,
  ChevronDown,
  ExternalLink,
  Loader2,
  MessageSquare,
  XCircle,
} from "lucide-react";
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
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-[#0088cc]" />
              Telegram Bot
            </CardTitle>
            <CardDescription>Connect your Telegram bot for AI-powered automation</CardDescription>
          </div>
          {status?.connected && (
            <Badge variant="default" className="bg-green-500">
              <CheckCircle className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {status?.connected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-muted rounded-lg">
              <div className="h-12 w-12 rounded-full bg-[#0088cc] flex items-center justify-center">
                <Bot className="h-6 w-6 text-white" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">@{status.botUsername}</div>
                <div className="text-sm text-muted-foreground">Bot ID: {status.botId}</div>
                {status.error && (
                  <div className="text-sm text-yellow-600 mt-1">⚠️ {status.error}</div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`https://t.me/${status.botUsername}`, "_blank")}
              >
                <ExternalLink className="h-4 w-4 mr-1" />
                Open Bot
              </Button>
            </div>

            <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <p className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                Next: Start chatting with your bot
              </p>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Open Telegram and search for @{status.botUsername}</li>
                <li>Click &quot;Start&quot; to begin a conversation</li>
                <li>Send a message - your AI agent will respond</li>
              </ol>
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              <div className="text-sm text-muted-foreground">
                Chats are auto-detected when bot is added.
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:text-red-700"
                    disabled={isDisconnecting}
                  >
                    {isDisconnecting ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <XCircle className="h-4 w-4 mr-1" />
                    )}
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Telegram Bot?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove your bot credentials. Any active Telegram automation will
                      stop working until you reconnect.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDisconnect}
                      className="bg-red-600 hover:bg-red-700"
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Collapsible open={showInstructions} onOpenChange={setShowInstructions}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full justify-between p-4 h-auto bg-muted">
                  <span className="font-medium">How to create a Telegram bot</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      showInstructions ? "rotate-180" : ""
                    }`}
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="p-4 bg-muted rounded-b-lg border-t">
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
                    Send <code className="bg-background px-1 rounded">/newbot</code> command
                  </li>
                  <li>Choose a name for your bot (e.g., &quot;My App Bot&quot;)</li>
                  <li>Choose a username ending in &quot;bot&quot; (e.g., &quot;myapp_bot&quot;)</li>
                  <li>
                    Copy the <strong>API token</strong> BotFather gives you
                  </li>
                  <li>Paste the token below</li>
                </ol>
              </CollapsibleContent>
            </Collapsible>

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

            <div className="p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">What you can do with Telegram automation:</h4>
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
        )}
      </CardContent>
    </Card>
  );
}
