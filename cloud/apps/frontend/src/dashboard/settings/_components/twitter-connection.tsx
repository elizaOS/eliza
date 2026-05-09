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
} from "@elizaos/cloud-ui";
import { Image } from "@elizaos/cloud-ui";
import { CheckCircle, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface TwitterStatus {
  configured: boolean;
  connected: boolean;
  username?: string;
  userId?: string;
  avatarUrl?: string;
  error?: string;
}

export function TwitterConnection() {
  const [status, setStatus] = useState<TwitterStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const fetchStatus = async () => {
    setIsLoading(true);
    const response = await fetch("/api/v1/twitter/status");
    const data: TwitterStatus = await response.json();
    setStatus(data);
    setIsLoading(false);
  };

  useEffect(() => {
    const controller = new AbortController();

    const loadStatus = async () => {
      setIsLoading(true);
      const response = await fetch("/api/v1/twitter/status", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        const data: TwitterStatus = await response.json();
        setStatus(data);
        setIsLoading(false);
      }
    };

    loadStatus();

    const params = new URLSearchParams(window.location.search);
    if (params.get("twitter_connected") === "true") {
      const username = params.get("twitter_username");
      toast.success(`Twitter connected as @${username}`);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("twitter_error")) {
      const error = params.get("twitter_error_detail") ?? params.get("twitter_error");
      toast.error(`Twitter connection failed: ${error}`);
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => controller.abort();
  }, []);

  const handleConnect = async () => {
    if (isConnecting) return;
    setIsConnecting(true);

    let data: { authUrl?: string; error?: string } | undefined;
    try {
      const response = await fetch("/api/v1/twitter/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirectUrl: window.location.href,
        }),
      });

      data = await response.json();

      if (response.ok && data?.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
    } catch {
      toast.error("Network error. Please check your connection and try again.");
      setIsConnecting(false);
      return;
    }

    toast.error(data?.error || "Failed to connect Twitter. Please try again.");
    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);

    try {
      const response = await fetch("/api/v1/twitter/disconnect", {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Twitter disconnected");
        fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to disconnect Twitter. Please try again.");
      }
    } catch {
      toast.error("Network error. Please check your connection and try again.");
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

  if (!status?.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            Twitter/X Integration
          </CardTitle>
          <CardDescription>
            Twitter integration is not configured on this platform. Contact your administrator.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Twitter/X Integration
            </CardTitle>
            <CardDescription>
              Connect your Twitter account for AI-powered automation
            </CardDescription>
          </div>
          {status.connected && (
            <Badge variant="default" className="bg-green-500">
              <CheckCircle className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {status.connected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-muted rounded-lg">
              {status.avatarUrl && (
                <Image
                  src={status.avatarUrl}
                  alt={status.username || "Twitter avatar"}
                  width={48}
                  height={48}
                  className="rounded-full"
                  unoptimized
                />
              )}
              <div className="flex-1">
                <div className="font-semibold">@{status.username}</div>
                <div className="text-sm text-muted-foreground">Twitter ID: {status.userId}</div>
                {status.error && (
                  <div className="text-sm text-yellow-600 mt-1">⚠️ {status.error}</div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`https://twitter.com/${status.username}`, "_blank")}
              >
                <ExternalLink className="h-4 w-4 mr-1" />
                View Profile
              </Button>
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              <div className="text-sm text-muted-foreground">
                Enable Twitter automation in your agent settings to start posting.
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
                    <AlertDialogTitle>Disconnect Twitter?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove your Twitter credentials. Any active Twitter automation will
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
            <div className="p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">Connect Twitter to enable AI automation:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Autonomous posting in your agent&apos;s voice</li>
                <li>• Smart replies to mentions and DMs</li>
                <li>• Timeline engagement (likes, retweets, quotes)</li>
                <li>• Discover and follow relevant accounts</li>
              </ul>
            </div>

            <Button onClick={handleConnect} disabled={isConnecting} className="w-full">
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Connecting...
                </>
              ) : (
                <>
                  <svg
                    className="h-4 w-4 mr-2"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  Connect Twitter Account
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
