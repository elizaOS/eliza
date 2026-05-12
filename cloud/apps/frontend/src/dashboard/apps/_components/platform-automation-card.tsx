"use client";

/**
 * Platform Automation Card
 *
 * Card component that displays automation status and actions for a single platform.
 * Adapts its UI based on the platform's connection and automation state.
 *
 * States:
 * - Not Connected: Platform not linked to org
 * - Connected, No Automation: Can post manually, can set up automation
 * - Automated (Active): Full management UI
 * - Automated (Paused): Shows resume option
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
} from "@elizaos/cloud-ui";
import { formatDistanceToNow } from "date-fns";
import {
  Bird,
  Bot,
  Clock,
  ExternalLink,
  Hash,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Send,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

export type Platform = "discord" | "telegram" | "twitter";

interface AutomationConfig {
  enabled: boolean;
  channelId?: string;
  groupId?: string;
  guildId?: string;
  autoAnnounce?: boolean;
  autoPost?: boolean;
  autoReply?: boolean;
  announceIntervalMin?: number;
  announceIntervalMax?: number;
  postIntervalMin?: number;
  postIntervalMax?: number;
  lastAnnouncementAt?: string;
  lastPostAt?: string;
  totalMessages?: number;
  totalPosts?: number;
  agentCharacterId?: string;
  vibeStyle?: string;
}

interface PlatformStatus {
  enabled: boolean;
  connected: boolean;
  config: AutomationConfig | null;
  // Platform-specific
  guildName?: string;
  channelName?: string;
  botUsername?: string;
  username?: string;
}

interface PlatformAutomationCardProps {
  platform: Platform;
  appId: string;
  onEdit?: (platform: Platform) => void;
  onSetup?: (platform: Platform) => void;
  /** Change this value to force a refresh of the card's data */
  refreshKey?: number;
}

const PLATFORM_CONFIG = {
  discord: {
    name: "Discord",
    icon: Hash,
    color: "#5865F2",
    bgColor: "bg-[#5865F2]/10",
    borderColor: "border-[#5865F2]/30",
    textColor: "text-[#5865F2]",
    connectUrl: "/dashboard/settings?tab=connections",
  },
  telegram: {
    name: "Telegram",
    icon: Send,
    color: "#0088cc",
    bgColor: "bg-[#0088cc]/10",
    borderColor: "border-[#0088cc]/30",
    textColor: "text-[#0088cc]",
    connectUrl: "/dashboard/settings?tab=connections",
  },
  twitter: {
    name: "Twitter/X",
    icon: Bird,
    color: "#1DA1F2",
    bgColor: "bg-sky-500/10",
    borderColor: "border-sky-500/30",
    textColor: "text-sky-500",
    connectUrl: "/dashboard/settings?tab=connections",
  },
};

export function PlatformAutomationCard({
  platform,
  appId,
  onEdit,
  onSetup,
  refreshKey = 0,
}: PlatformAutomationCardProps) {
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const config = PLATFORM_CONFIG[platform];
  const Icon = config.icon;

  // Prevent multiple concurrent actions
  const isActionInProgress = isPosting || isToggling || isDeleting || isLoading;

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    try {
      const response = await fetch(`/api/v1/apps/${appId}/${platform}-automation`);
      if (response.ok) {
        const data = await response.json();

        // Check if automation has been configured (has channel/guild/etc)
        const hasAutomationConfig =
          data.channelId || data.groupId || data.guildId || data.autoAnnounce || data.autoPost;

        // Normalize the response based on platform
        // IMPORTANT: Preserve config even when enabled=false (paused state)
        const normalizedStatus: PlatformStatus = {
          enabled: data.enabled ?? false,
          connected:
            platform === "discord"
              ? (data.discordConnected ?? false)
              : platform === "telegram"
                ? (data.botConnected ?? false)
                : (data.twitterConnected ?? false),
          config: hasAutomationConfig
            ? {
                enabled: data.enabled ?? false,
                channelId: data.channelId,
                groupId: data.groupId,
                guildId: data.guildId,
                autoAnnounce: data.autoAnnounce,
                autoPost: data.autoPost,
                autoReply: data.autoReply,
                announceIntervalMin: data.announceIntervalMin,
                announceIntervalMax: data.announceIntervalMax,
                postIntervalMin: data.postIntervalMin,
                postIntervalMax: data.postIntervalMax,
                lastAnnouncementAt: data.lastAnnouncementAt,
                lastPostAt: data.lastPostAt,
                totalMessages: data.totalMessages,
                totalPosts: data.totalPosts,
                agentCharacterId: data.agentCharacterId,
                vibeStyle: data.vibeStyle,
              }
            : null,
          guildName: data.guildName,
          channelName: data.channelName,
          botUsername: data.botUsername,
          username: data.username,
        };

        setStatus(normalizedStatus);
      } else if (response.status === 401 || response.status === 403) {
        // Auth error - show error state
        setHasError(true);
        setStatus(null);
      } else {
        // Other API error - assume not connected but show status
        setStatus({
          enabled: false,
          connected: false,
          config: null,
        });
      }
    } catch {
      // Network error - show error state
      setHasError(true);
      setStatus(null);
    } finally {
      setIsLoading(false);
    }
  }, [appId, platform]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handlePostNow = async () => {
    if (isActionInProgress) return;
    setIsPosting(true);
    try {
      const response = await fetch(`/api/v1/apps/${appId}/${platform}-automation/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.success) {
        toast.success(`Posted to ${config.name} successfully!`);
        // Refresh status to update stats
        await fetchStatus();
      } else {
        toast.error(data.error || `Failed to post to ${config.name}`);
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsPosting(false);
    }
  };

  const handleTogglePause = async () => {
    if (!status || isActionInProgress) return;
    setIsToggling(true);

    try {
      const response = await fetch(`/api/v1/apps/${appId}/${platform}-automation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !status.enabled }),
      });

      if (response.ok) {
        toast.success(status.enabled ? "Automation paused" : "Automation resumed");
        await fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to update automation");
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsToggling(false);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return; // Prevent double-click
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/v1/apps/${appId}/${platform}-automation`, {
        method: "DELETE",
      });

      if (response.ok) {
        toast.success("Automation stopped");
        setShowDeleteDialog(false);
        await fetchStatus();
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.error || "Failed to stop automation");
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  // Calculate next post estimate
  const getNextPostEstimate = (): string | null => {
    if (!status?.enabled || !status.config) return null;

    const lastPost =
      platform === "twitter" ? status.config.lastPostAt : status.config.lastAnnouncementAt;

    if (!lastPost) return "Soon";

    const lastDate = new Date(lastPost);
    const minInterval =
      platform === "twitter"
        ? (status.config.postIntervalMin ?? 90)
        : (status.config.announceIntervalMin ?? 120);
    const maxInterval =
      platform === "twitter"
        ? (status.config.postIntervalMax ?? 150)
        : (status.config.announceIntervalMax ?? 240);

    // Estimate: midpoint of interval
    const avgInterval = (minInterval + maxInterval) / 2;
    const nextDate = new Date(lastDate.getTime() + avgInterval * 60 * 1000);
    const now = new Date();

    if (nextDate <= now) return "Soon";

    const minutesUntil = Math.round((nextDate.getTime() - now.getTime()) / (1000 * 60));
    if (minutesUntil < 60) return `~${minutesUntil} min`;
    const hoursUntil = Math.round(minutesUntil / 60);
    return `~${hoursUntil}h`;
  };

  // Format interval display
  const getIntervalDisplay = (): string => {
    if (!status?.config) return "";

    const minHours =
      platform === "twitter"
        ? (status.config.postIntervalMin ?? 90) / 60
        : (status.config.announceIntervalMin ?? 120) / 60;
    const maxHours =
      platform === "twitter"
        ? (status.config.postIntervalMax ?? 150) / 60
        : (status.config.announceIntervalMax ?? 240) / 60;

    return `${minHours.toFixed(0)}-${maxHours.toFixed(0)} hours`;
  };

  // Get total posts count
  const getTotalPosts = (): number => {
    if (!status?.config) return 0;
    return platform === "twitter"
      ? (status.config.totalPosts ?? 0)
      : (status.config.totalMessages ?? 0);
  };

  // Get last post time
  const getLastPostTime = (): string | null => {
    if (!status?.config) return null;
    const lastPost =
      platform === "twitter" ? status.config.lastPostAt : status.config.lastAnnouncementAt;
    if (!lastPost) return null;
    return formatDistanceToNow(new Date(lastPost), { addSuffix: true });
  };

  // Get target display (channel/group name)
  const getTargetDisplay = (): string => {
    if (!status) return "";

    if (platform === "discord") {
      if (status.guildName && status.channelName) {
        return `${status.guildName} > #${status.channelName}`;
      }
      return status.channelName ? `#${status.channelName}` : "No channel selected";
    }

    if (platform === "telegram") {
      const botName = status.botUsername ? `@${status.botUsername}` : "Bot";
      if (status.config?.channelId) {
        return `${botName} → Channel`;
      }
      if (status.config?.groupId) {
        return `${botName} → Group`;
      }
      return botName;
    }

    if (platform === "twitter") {
      return status.username ? `@${status.username}` : "Twitter account";
    }

    return "";
  };

  // Determine card state
  const getCardState = (): "not-connected" | "connected" | "active" | "paused" => {
    if (!status?.connected) return "not-connected";
    // Has config means automation was set up
    if (!status.config) return "connected";
    // Enabled and has auto-posting enabled = active
    if (status.enabled) return "active";
    // Has config but not enabled = paused
    return "paused";
  };

  const cardState = getCardState();

  if (isLoading) {
    return (
      <div
        className={`rounded-lg border ${config.borderColor} ${config.bgColor} p-4 animate-pulse`}
      >
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${config.bgColor}`}>
            <Icon className={`h-5 w-5 ${config.textColor}`} />
          </div>
          <div className="flex-1">
            <div className="h-5 bg-white/10 rounded w-24 mb-2" />
            <div className="h-4 bg-white/10 rounded w-48" />
          </div>
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className={`rounded-lg border border-red-500/30 bg-red-500/5 p-4`}>
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${config.bgColor} border ${config.borderColor}`}>
            <Icon className={`h-5 w-5 ${config.textColor}`} />
          </div>
          <div className="flex-1">
            <span className="font-medium text-white">{config.name}</span>
            <p className="text-sm text-red-400">Failed to load status. Check your connection.</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchStatus()}
            className="text-white/60 hover:text-white"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`rounded-lg border ${config.borderColor} ${config.bgColor} p-4`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${config.bgColor} border ${config.borderColor}`}>
              <Icon className={`h-5 w-5 ${config.textColor}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-white">{config.name}</span>
                {cardState === "active" && (
                  <Badge
                    variant="outline"
                    className="bg-green-500/10 border-green-500/30 text-green-400 text-xs"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5" />
                    Active
                  </Badge>
                )}
                {cardState === "paused" && (
                  <Badge
                    variant="outline"
                    className="bg-yellow-500/10 border-yellow-500/30 text-yellow-400 text-xs"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 mr-1.5" />
                    Paused
                  </Badge>
                )}
                {cardState === "connected" && (
                  <Badge
                    variant="outline"
                    className="bg-white/5 border-white/20 text-white/60 text-xs"
                  >
                    Not Set Up
                  </Badge>
                )}
                {cardState === "not-connected" && (
                  <Badge
                    variant="outline"
                    className="bg-white/5 border-white/20 text-white/40 text-xs"
                  >
                    Not Connected
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Content based on state */}
        {cardState === "not-connected" && (
          <div className="mb-4">
            <p className="text-white/60 text-sm mb-3">
              Connect your {config.name} account to enable posting and automation.
            </p>
            <Link to={config.connectUrl}>
              <Button variant="outline" size="sm" className="gap-2">
                <ExternalLink className="h-4 w-4" />
                Connect {config.name}
              </Button>
            </Link>
          </div>
        )}

        {(cardState === "active" || cardState === "paused") && (
          <div className="space-y-2 mb-4">
            <div className="text-sm text-white/80">{getTargetDisplay()}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/60">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Every {getIntervalDisplay()}
              </span>
              {platform === "telegram" && status?.config?.autoReply && (
                <span className="flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" />
                  Auto-reply on
                </span>
              )}
              {status?.config?.agentCharacterId && (
                <span className="flex items-center gap-1">
                  <Bot className="h-3 w-3" />
                  Agent voice
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
              {getLastPostTime() && <span>Last: {getLastPostTime()}</span>}
              {cardState === "active" && getNextPostEstimate() && (
                <span>Next: {getNextPostEstimate()}</span>
              )}
              <span>Total: {getTotalPosts()} posts</span>
            </div>
          </div>
        )}

        {cardState === "connected" && (
          <div className="mb-4">
            <p className="text-white/60 text-sm">
              No scheduled automation configured.
              <br />
              <span className="text-white/40">You can still post manually anytime.</span>
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {/* Post Now - always available when connected */}
          {status?.connected && (
            <Button
              variant="outline"
              size="sm"
              onClick={handlePostNow}
              disabled={isActionInProgress}
              className="gap-2"
            >
              {isPosting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {isPosting ? "Posting..." : "Send Post"}
            </Button>
          )}

          {/* Edit - when automation exists */}
          {(cardState === "active" || cardState === "paused") && onEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(platform)}
              disabled={isActionInProgress}
              className="gap-2"
            >
              <Settings className="h-4 w-4" />
              Edit
            </Button>
          )}

          {/* Set Up - when connected but no automation */}
          {cardState === "connected" && onSetup && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSetup(platform)}
              disabled={isActionInProgress}
              className={`gap-2 ${config.textColor} border-current hover:bg-current/10`}
            >
              <Settings className="h-4 w-4" />
              Set Up Automation
            </Button>
          )}

          {/* Pause/Resume - when automation exists */}
          {(cardState === "active" || cardState === "paused") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleTogglePause}
              disabled={isActionInProgress}
              className="gap-2"
            >
              {isToggling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : cardState === "active" ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {cardState === "active" ? "Pause" : "Resume"}
            </Button>
          )}

          {/* Delete - when automation exists */}
          {(cardState === "active" || cardState === "paused") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteDialog(true)}
              disabled={isActionInProgress}
              className="gap-2 text-red-400 hover:text-red-300 hover:bg-red-500/10"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-[#1a1a1a] border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">
              Stop {config.name} Automation?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-white/60">
              This will:
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Stop all scheduled posts</li>
                {platform === "telegram" && status?.config?.autoReply && (
                  <li>Disable auto-replies</li>
                )}
                <li>Your {getTotalPosts()} previous posts will remain</li>
              </ul>
              <p className="mt-3">You can always set up a new automation later.</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-white/5 border-white/10 text-white hover:bg-white/10">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Stopping...
                </>
              ) : (
                "Stop Automation"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
