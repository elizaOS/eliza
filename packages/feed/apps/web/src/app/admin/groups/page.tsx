/**
 * Admin Groups Debug Page
 *
 * @description Dedicated admin page for viewing ALL group chats in the system.
 * Provides comprehensive debug view with participants, messages, and statistics.
 * Accessible on localhost without authentication for debugging.
 *
 * @page /admin/groups
 * @access Admin / Localhost Debug
 */

"use client";

import { cn, logger } from "@feed/shared";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  MessageCircle,
  RefreshCw,
  Search,
  User as UserIcon,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { z } from "zod";
import { AdminStandalonePage } from "@/components/admin/AdminStandalonePage";

/**
 * Participant schema for validation.
 */
const ParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string().nullable().optional(),
  isNPC: z.boolean().optional().default(false),
  profileImageUrl: z.string().nullable().optional(),
  joinedAt: z.coerce.date(),
});

/**
 * Message schema for validation.
 */
const MessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.coerce.date(),
  sender: z.object({
    id: z.string(),
    name: z.string(),
    isNPC: z.boolean(),
  }),
});

/**
 * Group chat schema for validation.
 */
const GroupChatSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  groupType: z.string(),
  creatorId: z.string().nullable(),
  creatorName: z.string(),
  memberCount: z.number(),
  messageCount: z.number(),
  participants: z.array(ParticipantSchema),
  recentMessages: z.array(MessageSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
type GroupChat = z.infer<typeof GroupChatSchema>;

export default function AdminGroupsPage() {
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<
    "createdAt" | "memberCount" | "messageCount"
  >("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [isRefreshing, startRefresh] = useTransition();

  const fetchGroups = useCallback(async () => {
    startRefresh(async () => {
      setIsLoading(true);
      setError(null);

      const response = await fetch(
        `/api/admin/groups?sortBy=${sortBy}&sortOrder=${sortOrder}`,
      ).catch((err: Error) => {
        logger.error(
          "Failed to fetch groups",
          err instanceof Error ? err : { error: err },
          "AdminGroupsPage",
        );
        setError("Failed to fetch groups. Are you on localhost?");
        setIsLoading(false);
        throw err;
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("API error", { errorText }, "AdminGroupsPage");
        setError(`API error: ${response.status} - ${errorText}`);
        setIsLoading(false);
        return;
      }

      const data = await response.json();
      const validation = z.array(GroupChatSchema).safeParse(data.data?.groups);
      if (!validation.success) {
        logger.error(
          "Validation error",
          { error: validation.error },
          "AdminGroupsPage",
        );
        setError("Invalid group data structure from API");
        setIsLoading(false);
        return;
      }
      setGroups(validation.data || []);
      setIsLoading(false);
    });
  }, [sortBy, sortOrder]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  const toggleExpanded = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const filteredGroups = groups.filter(
    (group) =>
      group.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      group.creatorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      group.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      group.participants.some((p) =>
        p.name.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
  );

  const getGroupTypeLabel = (type: string) => {
    switch (type) {
      case "npc-only":
        return "NPC Only";
      case "npc-mixed":
        return "NPC + Users";
      case "user":
        return "User Created";
      default:
        return "Unknown";
    }
  };

  const getGroupTypeColor = (type: string) => {
    switch (type) {
      case "npc-only":
        return "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20";
      case "npc-mixed":
        return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
      case "user":
        return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  };

  // Stats summary
  const totalGroups = groups.length;
  const npcOnlyGroups = groups.filter((g) => g.groupType === "npc-only").length;
  const npcMixedGroups = groups.filter(
    (g) => g.groupType === "npc-mixed",
  ).length;
  const userGroups = groups.filter((g) => g.groupType === "user").length;
  const totalParticipants = groups.reduce((sum, g) => sum + g.memberCount, 0);
  const totalMessages = groups.reduce((sum, g) => sum + g.messageCount, 0);

  return (
    <AdminStandalonePage>
      {/* Header */}
      <div className="mb-6 border-border border-b pb-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="h-8 w-8 text-primary" />
            <div>
              <h1 className="font-bold text-2xl">Group Chats Debug</h1>
              <p className="text-muted-foreground text-sm">
                Viewing all {totalGroups} group chats in the system
              </p>
            </div>
          </div>
          <button
            onClick={fetchGroups}
            disabled={isLoading || isRefreshing}
            className={cn(
              "flex items-center gap-2 rounded-lg px-4 py-2",
              "bg-primary text-primary-foreground",
              "transition-colors hover:bg-primary/90",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                (isLoading || isRefreshing) && "animate-spin",
              )}
            />
            Refresh
          </button>
        </div>

        {/* Summary Stats */}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-muted-foreground text-xs">Total Groups</p>
            <p className="font-bold text-2xl">{totalGroups}</p>
          </div>
          <div className="rounded-lg border border-purple-500/20 bg-purple-500/10 p-3">
            <p className="text-purple-600 text-xs dark:text-purple-400">
              NPC Only
            </p>
            <p className="font-bold text-2xl text-purple-600 dark:text-purple-400">
              {npcOnlyGroups}
            </p>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3">
            <p className="text-blue-600 text-xs dark:text-blue-400">
              NPC + Users
            </p>
            <p className="font-bold text-2xl text-blue-600 dark:text-blue-400">
              {npcMixedGroups}
            </p>
          </div>
          <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-3">
            <p className="text-green-600 text-xs dark:text-green-400">
              User Groups
            </p>
            <p className="font-bold text-2xl text-green-600 dark:text-green-400">
              {userGroups}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-muted-foreground text-xs">Total Participants</p>
            <p className="font-bold text-2xl">{totalParticipants}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-muted-foreground text-xs">Total Messages</p>
            <p className="font-bold text-2xl">{totalMessages}</p>
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="mb-4 flex flex-col gap-4 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, creator, participant, or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={cn(
              "w-full rounded-lg border border-border py-2 pr-4 pl-10",
              "bg-background text-foreground",
              "focus:border-primary focus:outline-none",
            )}
          />
        </div>
        <div className="flex gap-2">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className={cn(
              "rounded-lg border border-border px-4 py-2",
              "bg-background text-foreground",
              "focus:border-primary focus:outline-none",
            )}
          >
            <option value="createdAt">Created Date</option>
            <option value="memberCount">Member Count</option>
            <option value="messageCount">Message Count</option>
          </select>
          <button
            onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
            className={cn(
              "rounded-lg border border-border px-4 py-2",
              "bg-background transition-colors hover:bg-muted",
            )}
          >
            {sortOrder === "asc" ? "↑ Asc" : "↓ Desc"}
          </button>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-4">
          <p className="text-red-600 dark:text-red-400">{error}</p>
          <p className="mt-2 text-red-600/70 text-sm dark:text-red-400/70">
            Make sure the backend is running and you&apos;re accessing from
            localhost.
          </p>
        </div>
      )}

      {/* Groups List */}
      <div>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Users className="mx-auto mb-4 h-12 w-12 opacity-50" />
            <p className="font-medium">No group chats found</p>
            <p className="mt-1 text-sm">
              {searchTerm
                ? "Try adjusting your search"
                : "Group chats will appear here when created"}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredGroups.map((group) => {
              const isExpanded = expandedGroups.has(group.id);
              return (
                <div
                  key={group.id}
                  className="overflow-hidden rounded-lg border border-border bg-card"
                >
                  {/* Group Header (clickable to expand) */}
                  <div
                    className="flex cursor-pointer items-center gap-3 p-4 hover:bg-muted/50"
                    onClick={() => toggleExpanded(group.id)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-5 w-5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-semibold">
                          {group.name || "Unnamed Group"}
                        </h3>
                        <span
                          className={cn(
                            "shrink-0 rounded border px-2 py-0.5 font-medium text-xs",
                            getGroupTypeColor(group.groupType),
                          )}
                        >
                          {getGroupTypeLabel(group.groupType)}
                        </span>
                      </div>
                      <p className="truncate text-muted-foreground text-xs">
                        ID: {group.id}
                      </p>
                    </div>

                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-1">
                        <UserIcon className="h-4 w-4 text-muted-foreground" />
                        <span>{group.memberCount}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <MessageCircle className="h-4 w-4 text-muted-foreground" />
                        <span>{group.messageCount}</span>
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground text-xs">
                        <Calendar className="h-3 w-3" />
                        <span>
                          {new Date(group.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="border-border border-t bg-muted/30 p-4">
                      <div className="grid gap-4 lg:grid-cols-2">
                        {/* Participants */}
                        <div>
                          <h4 className="mb-2 font-medium">
                            Participants ({group.participants.length})
                          </h4>
                          <div className="max-h-64 space-y-2 overflow-y-auto">
                            {group.participants.map((participant) => (
                              <div
                                key={participant.id}
                                className="flex items-center justify-between rounded bg-background p-2"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-sm">
                                    {participant.name}
                                  </span>
                                  {participant.username && (
                                    <span className="text-muted-foreground text-xs">
                                      @{participant.username}
                                    </span>
                                  )}
                                  {participant.isNPC && (
                                    <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-purple-600 text-xs dark:text-purple-400">
                                      NPC
                                    </span>
                                  )}
                                </div>
                                <span className="text-muted-foreground text-xs">
                                  {new Date(
                                    participant.joinedAt,
                                  ).toLocaleDateString()}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Recent Messages */}
                        <div>
                          <h4 className="mb-2 font-medium">
                            Recent Messages ({group.recentMessages.length})
                          </h4>
                          {group.recentMessages.length === 0 ? (
                            <p className="text-muted-foreground text-sm">
                              No messages yet
                            </p>
                          ) : (
                            <div className="max-h-64 space-y-2 overflow-y-auto">
                              {group.recentMessages.map((message) => (
                                <div
                                  key={message.id}
                                  className="rounded bg-background p-3"
                                >
                                  <div className="mb-1 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium text-sm">
                                        {message.sender.name}
                                      </span>
                                      {message.sender.isNPC && (
                                        <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-purple-600 text-xs dark:text-purple-400">
                                          NPC
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-muted-foreground text-xs">
                                      {new Date(
                                        message.createdAt,
                                      ).toLocaleString()}
                                    </span>
                                  </div>
                                  <p className="line-clamp-2 text-sm">
                                    {message.content}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Group Meta */}
                      <div className="mt-4 flex flex-wrap gap-4 border-border border-t pt-4 text-muted-foreground text-xs">
                        <span>Creator: {group.creatorName}</span>
                        <span>
                          Created: {new Date(group.createdAt).toLocaleString()}
                        </span>
                        <span>
                          Updated: {new Date(group.updatedAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminStandalonePage>
  );
}
