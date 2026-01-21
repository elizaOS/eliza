/**
 * Moderation Settings Page
 *
 * Manage blocked and muted users
 */

"use client";

import { cn } from "@polyagent/shared";
import { Ban, Trash2, UserX, VolumeX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/shared/Avatar";
import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";

interface BlockedUser {
  id: string;
  createdAt: string;
  reason: string | null;
  blocked: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
  };
}

interface MutedUser {
  id: string;
  createdAt: string;
  reason: string | null;
  muted: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
  };
}

type Tab = "blocked" | "muted";

export default function ModerationSettingsPage() {
  const { authenticated } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("blocked");
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [mutedUsers, setMutedUsers] = useState<MutedUser[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchBlockedUsers = useCallback(async () => {
    const response = await fetch("/api/moderation/blocks");
    if (!response.ok) {
      toast.error("Failed to load blocked users");
      setLoading(false);
      return;
    }

    const data = await response.json();
    setBlockedUsers(data.blocks || []);
    setLoading(false);
  }, []);

  const fetchMutedUsers = useCallback(async () => {
    const response = await fetch("/api/moderation/mutes");
    if (!response.ok) {
      toast.error("Failed to load muted users");
      return;
    }

    const data = await response.json();
    setMutedUsers(data.mutes || []);
  }, []);

  useEffect(() => {
    if (authenticated) {
      fetchBlockedUsers();
      fetchMutedUsers();
    }
  }, [authenticated, fetchBlockedUsers, fetchMutedUsers]);

  const handleUnblock = async (userId: string, displayName: string) => {
    const response = await fetch(`/api/users/${userId}/block`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unblock" }),
    });

    if (!response.ok) {
      toast.error("Failed to unblock user");
      return;
    }

    toast.success(`Unblocked ${displayName}`);
    fetchBlockedUsers();
  };

  const handleUnmute = async (userId: string, displayName: string) => {
    const response = await fetch(`/api/users/${userId}/mute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unmute" }),
    });

    if (!response.ok) {
      toast.error("Failed to unmute user");
      return;
    }

    toast.success(`Unmuted ${displayName}`);
    fetchMutedUsers();
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  if (!authenticated) {
    return (
      <PageContainer>
        <div className="py-12 text-center">
          <p className="text-muted-foreground">
            Please log in to view moderation settings.
          </p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6">
          <h1 className="mb-2 font-bold text-3xl">Moderation Settings</h1>
          <p className="text-muted-foreground">
            Manage your blocked and muted users
          </p>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex gap-2 border-border border-b">
          <button
            onClick={() => setActiveTab("blocked")}
            className={cn(
              "-mb-[1px] flex items-center gap-2 border-b-2 px-4 py-2 font-medium transition-colors",
              activeTab === "blocked"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Ban className="h-4 w-4" />
            Blocked ({blockedUsers.length})
          </button>
          <button
            onClick={() => setActiveTab("muted")}
            className={cn(
              "-mb-[1px] flex items-center gap-2 border-b-2 px-4 py-2 font-medium transition-colors",
              activeTab === "muted"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <VolumeX className="h-4 w-4" />
            Muted ({mutedUsers.length})
          </button>
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <>
            {/* Blocked Users */}
            {activeTab === "blocked" && (
              <div className="space-y-3">
                {blockedUsers.length === 0 ? (
                  <div className="rounded-lg border border-border bg-card py-12 text-center">
                    <UserX className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground">No blocked users</p>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Users you block will appear here
                    </p>
                  </div>
                ) : (
                  blockedUsers.map((block) => {
                    const user = block.blocked;
                    const displayName =
                      user.displayName || user.username || "User";

                    return (
                      <div
                        key={block.id}
                        className="flex items-center gap-4 rounded-lg border border-border bg-card p-4"
                      >
                        <Avatar
                          src={user.profileImageUrl || undefined}
                          alt={displayName}
                          size="md"
                        />

                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{displayName}</div>
                          {user.username && (
                            <div className="text-muted-foreground text-sm">
                              @{user.username}
                            </div>
                          )}
                          {block.reason && (
                            <div className="mt-1 text-muted-foreground text-xs">
                              Reason: {block.reason}
                            </div>
                          )}
                          <div className="mt-1 text-muted-foreground text-xs">
                            Blocked {formatDate(block.createdAt)}
                          </div>
                        </div>

                        <button
                          onClick={() => handleUnblock(user.id, displayName)}
                          className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2 transition-colors hover:bg-muted/80"
                        >
                          <Trash2 className="h-4 w-4" />
                          Unblock
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Muted Users */}
            {activeTab === "muted" && (
              <div className="space-y-3">
                {mutedUsers.length === 0 ? (
                  <div className="rounded-lg border border-border bg-card py-12 text-center">
                    <VolumeX className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground">No muted users</p>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Users you mute will appear here
                    </p>
                  </div>
                ) : (
                  mutedUsers.map((mute) => {
                    const user = mute.muted;
                    const displayName =
                      user.displayName || user.username || "User";

                    return (
                      <div
                        key={mute.id}
                        className="flex items-center gap-4 rounded-lg border border-border bg-card p-4"
                      >
                        <Avatar
                          src={user.profileImageUrl || undefined}
                          alt={displayName}
                          size="md"
                        />

                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{displayName}</div>
                          {user.username && (
                            <div className="text-muted-foreground text-sm">
                              @{user.username}
                            </div>
                          )}
                          {mute.reason && (
                            <div className="mt-1 text-muted-foreground text-xs">
                              Reason: {mute.reason}
                            </div>
                          )}
                          <div className="mt-1 text-muted-foreground text-xs">
                            Muted {formatDate(mute.createdAt)}
                          </div>
                        </div>

                        <button
                          onClick={() => handleUnmute(user.id, displayName)}
                          className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2 transition-colors hover:bg-muted/80"
                        >
                          <Trash2 className="h-4 w-4" />
                          Unmute
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}
