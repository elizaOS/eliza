"use client";

export const dynamic = "force-dynamic";

import { cn, logger } from "@feed/shared";
import { Bell, Settings } from "lucide-react";
import nextDynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { GroupInviteCard } from "@/components/groups/GroupInviteCard";
import { Avatar } from "@/components/shared/Avatar";
import { PageContainer } from "@/components/shared/PageContainer";
import { PullToRefreshIndicator } from "@/components/shared/PullToRefreshIndicator";
import { useAuth } from "@/hooks/useAuth";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { getNotificationPresentation } from "@/lib/notifications/presentation";

const WidgetSidebar = nextDynamic(
  () =>
    import("@/components/shared/WidgetSidebar").then((m) => ({
      default: m.WidgetSidebar,
    })),
  {
    ssr: false,
    loading: () => <div className="hidden w-96 flex-none xl:block" />,
  },
);

interface Notification {
  id: string;
  type: string;
  title: string;
  actorId: string | null;
  actor: {
    id: string;
    displayName: string;
    username: string | null;
    profileImageUrl: string | null;
  } | null;
  postId: string | null;
  commentId: string | null;
  chatId: string | null;
  groupId: string | null;
  inviteId: string | null;
  message: string;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

interface GroupInvite {
  inviteId: string;
  groupId: string;
  groupName: string;
  groupDescription: string | null;
  memberCount: number;
  invitedAt: string;
}

export default function NotificationsPage() {
  const { authenticated, user, getAccessToken, login } = useAuth();
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [groupInvites, setGroupInvites] = useState<GroupInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (authenticated) return;
    router.push("/feed");
    const timer = setTimeout(() => login(), 500);
    return () => clearTimeout(timer);
  }, [authenticated, router, login]);

  const fetchNotifications = useCallback(
    async (showLoading = true, silent = false) => {
      if (showLoading) {
        setLoading(true);
      }
      const token = await getAccessToken();

      if (!token) {
        if (showLoading) {
          setLoading(false);
        }
        return;
      }

      const [notifResponse, invitesResponse] = await Promise.all([
        fetch("/api/notifications?limit=100", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
        fetch("/api/groups/invites", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      ]);

      if (notifResponse.ok) {
        const data = await notifResponse.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      } else {
        logger.error(
          "Failed to fetch notifications",
          { statusText: notifResponse.statusText },
          "NotificationsPage",
        );
        if (!silent) {
          toast.error("Failed to refresh notifications");
        }
      }

      if (invitesResponse.ok) {
        const data = await invitesResponse.json();
        setGroupInvites(data.invites || []);
      }

      if (showLoading) {
        setLoading(false);
      }
    },
    [getAccessToken],
  );

  const handleRefresh = useCallback(async () => {
    await fetchNotifications(false, false); // Show loading via pull-to-refresh indicator, show toast on complete
  }, [fetchNotifications]);

  // Pull-to-refresh hook
  const { pullDistance, isRefreshing, containerRef } = usePullToRefresh({
    onRefresh: handleRefresh,
  });

  useEffect(() => {
    if (!authenticated || !user) {
      setLoading(false);
      return;
    }

    fetchNotifications(true, true); // Initial load: show loading, but silent (no toast)

    // Poll for new notifications every 1 minute when page is visible
    // Use silent refresh (no loading indicator) for polling
    const interval = setInterval(() => {
      // Only refresh if page is visible (not in background tab)
      if (document.visibilityState === "visible") {
        fetchNotifications(false, true); // Silent refresh, no loading indicator, no toast
      }
    }, 60000); // 60 seconds = 1 minute

    return () => clearInterval(interval);
  }, [authenticated, user, fetchNotifications]);

  const markAsRead = useCallback(
    async (notificationId: string, isAlreadyRead: boolean) => {
      // Skip if already marked as read
      if (isAlreadyRead) {
        return;
      }

      const token = await getAccessToken();

      if (!token) return;

      // Update local state optimistically first
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));

      // Then make the API call
      const response = await fetch("/api/notifications", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          notificationIds: [notificationId],
        }),
      });

      if (!response.ok) {
        logger.error(
          "Failed to mark notification as read",
          { statusText: response.statusText },
          "NotificationsPage",
        );
        // Revert optimistic update on error
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notificationId ? { ...n, read: false } : n,
          ),
        );
        setUnreadCount((prev) => prev + 1);
      }
    },
    [getAccessToken],
  );

  // Intersection Observer - marks notifications as read after viewing for 3 seconds
  useEffect(() => {
    if (!authenticated || notifications.length === 0) return;

    const timers = new Map<string, NodeJS.Timeout>();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const notificationId = entry.target.getAttribute(
            "data-notification-id",
          );
          if (!notificationId) return;

          const notification = notifications.find(
            (n) => n.id === notificationId,
          );
          if (!notification || notification.read) return;

          if (entry.isIntersecting) {
            // Clear any existing timer first (in case notification re-enters viewport)
            const existingTimer = timers.get(notificationId);
            if (existingTimer) {
              clearTimeout(existingTimer);
            }

            // Start a timer when notification becomes visible
            const timer = setTimeout(() => {
              markAsRead(notificationId, false);
            }, 3000); // 3 seconds delay

            timers.set(notificationId, timer);
          } else {
            // Cancel timer if notification leaves viewport before 3 seconds
            const timer = timers.get(notificationId);
            if (timer) {
              clearTimeout(timer);
              timers.delete(notificationId);
            }
          }
        });
      },
      {
        threshold: 0.5, // At least 50% of notification must be visible
        rootMargin: "-50px", // Adds margin to trigger when fully in view
      },
    );

    // Observe all notification elements
    const notificationElements = document.querySelectorAll(
      "[data-notification-id]",
    );
    notificationElements.forEach((el) => observer.observe(el));

    // Cleanup
    return () => {
      observer.disconnect();
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, [notifications, authenticated, markAsRead]);

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) return "Just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "comment":
        return "💬";
      case "reaction":
        return "❤️";
      case "follow":
        return "👤";
      case "mention":
        return "📢";
      case "reply":
        return "↩️";
      case "share":
        return "🔁";
      case "system":
        return "✨";
      default:
        return "🔔";
    }
  };

  const getNotificationLink = (notification: Notification) => {
    if (
      notification.type === "market_resolved" &&
      typeof notification.data?.deepLink === "string"
    ) {
      return notification.data.deepLink;
    }

    if (
      notification.type === "hourly_summary" ||
      notification.type === "daily_summary" ||
      notification.type === "weekly_summary"
    ) {
      return "/notifications";
    }

    // DM or group chat message - go to the specific chat if chatId is available
    if (notification.chatId) {
      return `/chats?chat=${notification.chatId}`;
    }

    // Group chat invite - go to chat
    if (
      notification.type === "system" &&
      notification.message.includes("invited you to")
    ) {
      // Extract chat ID from the message or notification data
      // For now, go to chats page where they can see their invitations
      return "/chats";
    }

    // DM or group chat message without chatId (legacy notifications) - go to chats page
    if (
      notification.type === "system" &&
      (notification.message.includes("Message") ||
        notification.message.includes("message"))
    ) {
      return "/chats";
    }

    // Profile completion - go to settings
    if (
      notification.type === "system" &&
      notification.message.includes("profile")
    ) {
      return "/settings";
    }

    // Follow notification - go to the follower's profile
    if (notification.type === "follow" && notification.actorId) {
      return `/profile/${notification.actorId}`;
    }

    // Comment or reaction on post - go to the post detail page
    if (
      (notification.type === "comment" ||
        notification.type === "reaction" ||
        notification.type === "reply") &&
      notification.postId
    ) {
      return `/post/${notification.postId}`;
    }

    // Share notification - go to the post
    if (notification.type === "share" && notification.postId) {
      return `/post/${notification.postId}`;
    }

    // Mention - go to the post if available
    if (notification.type === "mention" && notification.postId) {
      return `/post/${notification.postId}`;
    }

    // Default: go to feed
    return "/feed";
  };

  if (!authenticated) {
    return null;
  }

  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div ref={containerRef} className="relative flex flex-1">
        {/* Notifications area */}
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
          {/* Header */}
          <div className="sticky top-0 z-10 flex-shrink-0 bg-background shadow-sm">
            <div className="w-full px-4 py-3 lg:mx-auto lg:max-w-[700px] lg:px-6">
              <div className="flex items-center justify-between">
                <h1 className="font-bold text-xl">Notifications</h1>
                <Link
                  href="/settings?tab=notifications"
                  className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  <Settings className="h-5 w-5" />
                </Link>
              </div>
              {unreadCount > 0 && (
                <p className="text-muted-foreground text-sm">
                  {unreadCount} unread
                </p>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              <PullToRefreshIndicator
                pullDistance={pullDistance}
                isRefreshing={isRefreshing}
              />
              {loading ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="text-muted-foreground">
                    Loading notifications...
                  </div>
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Bell className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
                  <h2 className="mb-2 font-semibold text-xl">
                    No notifications yet
                  </h2>
                  <p className="px-4 text-center text-muted-foreground">
                    When you get comments, reactions, follows, or mentions,
                    they&apos;ll show up here.
                  </p>
                </div>
              ) : (
                <div className="space-y-0">
                  {/* Group Invites Section */}
                  {groupInvites.length > 0 && (
                    <div className="space-y-3 sm:px-4 sm:py-4 lg:px-6">
                      <h3 className="font-semibold text-muted-foreground text-sm">
                        Pending Group Invites
                      </h3>
                      {groupInvites.map((invite) => (
                        <GroupInviteCard
                          key={invite.inviteId}
                          inviteId={invite.inviteId}
                          groupId={invite.groupId}
                          groupName={invite.groupName}
                          groupDescription={invite.groupDescription}
                          memberCount={invite.memberCount}
                          invitedAt={invite.invitedAt}
                          onAccepted={(_groupId, chatId) => {
                            fetchNotifications(false, true);
                            if (chatId) {
                              router.push(`/chats?chat=${chatId}`);
                            }
                          }}
                          onDeclined={() => {
                            fetchNotifications(false, true);
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* Regular Notifications */}
                  {notifications.map((notification) => {
                    const presentation =
                      getNotificationPresentation(notification);

                    return (
                      <Link
                        key={notification.id}
                        href={getNotificationLink(notification)}
                        onClick={() =>
                          markAsRead(notification.id, notification.read)
                        }
                        data-notification-id={notification.id}
                        className={cn(
                          "block border-border border-b px-4 py-4 lg:px-6",
                          "transition-colors hover:bg-muted/30",
                          !notification.read && "bg-primary/5",
                        )}
                      >
                        <div className="flex items-center gap-3">
                          {/* Unread Indicator */}
                          {!notification.read && (
                            <div className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                          )}

                          {/* Actor Avatar */}
                          {notification.actor && !presentation.isSystemStyle ? (
                            <Avatar
                              id={notification.actor.id}
                              name={notification.actor.displayName}
                              size="md"
                              className="shrink-0"
                            />
                          ) : (
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                              {notification.type === "system" ? (
                                <span className="text-xl">
                                  {getNotificationIcon(notification.type)}
                                </span>
                              ) : (
                                <Bell className="h-5 w-5 text-muted-foreground" />
                              )}
                            </div>
                          )}

                          {/* Content */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start gap-3">
                              <div className="flex-1">
                                {presentation.isSystemStyle ? (
                                  <div className="space-y-1">
                                    {presentation.title ? (
                                      <p className="font-semibold text-foreground leading-snug">
                                        {presentation.title}
                                      </p>
                                    ) : null}
                                    <p className="text-muted-foreground leading-relaxed">
                                      {presentation.message}{" "}
                                      <time className="text-muted-foreground/70 text-xs">
                                        {formatTimeAgo(notification.createdAt)}
                                      </time>
                                    </p>
                                  </div>
                                ) : (
                                  <p className="text-foreground leading-relaxed">
                                    <span className="block font-semibold md:inline">
                                      {notification.actor?.displayName ||
                                        "Someone"}
                                    </span>{" "}
                                    <span className="text-muted-foreground">
                                      {notification.message
                                        .replace(
                                          notification.actor?.displayName || "",
                                          "",
                                        )
                                        .replace(/^:\s*/, "")}
                                    </span>{" "}
                                    <time className="text-muted-foreground/70 text-xs">
                                      {formatTimeAgo(notification.createdAt)}
                                    </time>
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Widget sidebar - lazy loaded, desktop only */}
        <WidgetSidebar />
      </div>
    </PageContainer>
  );
}
