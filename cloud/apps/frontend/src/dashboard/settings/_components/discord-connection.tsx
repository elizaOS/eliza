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
  DiscordIcon,
  Image,
} from "@elizaos/cloud-ui";
import { CheckCircle, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface DiscordGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  channelCount: number;
}

interface DiscordStatus {
  configured: boolean;
  connected: boolean;
  guilds: DiscordGuild[];
  error?: string;
}

export function DiscordConnection() {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [disconnectingGuildId, setDisconnectingGuildId] = useState<string | null>(null);

  const fetchStatus = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/v1/discord/status");
      const data: DiscordStatus = await response.json();
      setStatus(data);
    } catch {
      toast.error("Failed to fetch Discord status");
    }
    setIsLoading(false);
  };

  useEffect(() => {
    const controller = new AbortController();

    const loadStatus = async () => {
      setIsLoading(true);
      try {
        const response = await fetch("/api/v1/discord/status", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const data: DiscordStatus = await response.json();
          setStatus(data);
          setIsLoading(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    loadStatus();

    // Check for redirect params (after OAuth callback)
    const params = new URLSearchParams(window.location.search);
    const discordStatus = params.get("discord");
    if (discordStatus === "connected") {
      const guildName = params.get("guildName");
      toast.success(
        guildName
          ? `Discord server "${decodeURIComponent(guildName)}" connected!`
          : "Discord server connected!",
      );
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("discord");
      url.searchParams.delete("guildId");
      url.searchParams.delete("guildName");
      window.history.replaceState({}, "", url.toString());
    } else if (discordStatus === "error") {
      const message = params.get("message");
      toast.error(
        message ? `Discord error: ${decodeURIComponent(message)}` : "Discord connection failed",
      );
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("discord");
      url.searchParams.delete("message");
      window.history.replaceState({}, "", url.toString());
    }

    return () => controller.abort();
  }, []);

  const handleAddServer = () => {
    // Redirect to OAuth flow
    window.location.href = "/api/v1/discord/oauth?returnUrl=/dashboard/settings?tab=connections";
  };

  const handleRefreshChannels = async (guildId: string) => {
    setIsRefreshing(true);
    try {
      const response = await fetch("/api/v1/discord/channels/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(`Refreshed ${data.channelCount} channels`);
        fetchStatus();
      } else {
        toast.error(data.error || "Failed to refresh channels");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }
    setIsRefreshing(false);
  };

  const handleDisconnect = async (guildId: string) => {
    setDisconnectingGuildId(guildId);

    try {
      const response = await fetch("/api/v1/discord/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId }),
      });

      if (response.ok) {
        toast.success("Discord server disconnected");
        fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to disconnect");
      }
    } catch {
      toast.error("Network error. Please check your connection.");
    }

    setDisconnectingGuildId(null);
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
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <DiscordIcon className="h-5 w-5 text-[#5865F2]" />
                Discord Bot
              </CardTitle>
              <CardDescription>Discord integration is not configured</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="p-4 bg-muted rounded-lg">
            <p className="text-sm text-muted-foreground">
              Discord integration requires environment variables to be configured. Please contact
              your administrator.
            </p>
          </div>
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
              <DiscordIcon className="h-5 w-5 text-[#5865F2]" />
              Discord Bot
            </CardTitle>
            <CardDescription>Connect Discord servers for AI-powered automation</CardDescription>
          </div>
          {status?.connected && (
            <Badge variant="default" className="bg-green-500">
              <CheckCircle className="h-3 w-3 mr-1" />
              {status.guilds.length} Server
              {status.guilds.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {status?.connected && status.guilds.length > 0 ? (
          <div className="space-y-4">
            {/* Connected Servers */}
            <div className="space-y-3">
              {status.guilds.map((guild) => (
                <div key={guild.id} className="flex items-center gap-4 p-4 bg-muted rounded-lg">
                  <div className="h-12 w-12 rounded-full bg-[#5865F2] flex items-center justify-center overflow-hidden">
                    {guild.iconUrl ? (
                      <Image
                        src={guild.iconUrl}
                        alt={guild.name}
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <span className="text-white font-semibold text-lg">
                        {guild.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{guild.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {guild.channelCount} text channel
                      {guild.channelCount !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRefreshChannels(guild.id)}
                      disabled={isRefreshing}
                    >
                      <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          disabled={disconnectingGuildId === guild.id}
                        >
                          {disconnectingGuildId === guild.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove {guild.name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove the bot from this server. Any active Discord automation
                            for this server will stop working.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDisconnect(guild.id)}
                            className="bg-red-600 hover:bg-red-700"
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ))}
            </div>

            {/* Add Another Server */}
            <Button variant="outline" className="w-full" onClick={handleAddServer}>
              <Plus className="h-4 w-4 mr-2" />
              Add Another Server
            </Button>

            {/* Next Steps */}
            <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <p className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                Next: Enable automation for your apps
              </p>
              <p className="text-xs text-muted-foreground">
                Go to your app&apos;s Promote tab to enable Discord announcements.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">What you can do with Discord automation:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>- Post AI-generated announcements to channels</li>
                <li>- Share app updates with your Discord community</li>
                <li>- Include rich embeds with app info and buttons</li>
                <li>- Schedule periodic promotional posts</li>
              </ul>
            </div>

            <Button onClick={handleAddServer} className="w-full bg-[#5865F2] hover:bg-[#4752C4]">
              <DiscordIcon className="h-4 w-4 mr-2" />
              Add to Discord
            </Button>

            <p className="text-xs text-center text-muted-foreground">
              You&apos;ll be redirected to Discord to select a server
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
