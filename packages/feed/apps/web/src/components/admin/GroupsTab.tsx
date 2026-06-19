"use client";

import { cn } from "@feed/shared";
import {
  Calendar,
  MessageCircle,
  RefreshCw,
  Search,
  User as UserIcon,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { z } from "zod";
import { getAuthToken } from "@/lib/auth";
import { apiUrl } from "@/utils/api-url";

/**
 * Participant schema for validation.
 */
const ParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string().nullable(),
  isNPC: z.boolean(),
  profileImageUrl: z.string().nullable(),
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

/**
 * Groups tab component for managing and monitoring group chats.
 *
 * Displays a list of all group chats in the system with filtering, sorting,
 * and search functionality. Shows group details including participants,
 * recent messages, and statistics. Includes group creation form for testing.
 *
 * Features:
 * - Group list display
 * - Search functionality
 * - Sorting (by creation date, member count, message count)
 * - Group details view
 * - Participant list
 * - Recent messages display
 * - Group creation form
 * - Auto-refresh
 * - Loading states
 * - Error handling
 *
 * @returns Groups tab element
 */
export function GroupsTab() {
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<GroupChat | null>(null);
  const [sortBy, setSortBy] = useState<
    "createdAt" | "memberCount" | "messageCount"
  >("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [isRefreshing, startRefresh] = useTransition();

  const fetchGroups = useCallback(async () => {
    startRefresh(async () => {
      setIsLoading(true);
      const token = getAuthToken();

      if (!token) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        apiUrl(`/api/admin/groups?sortBy=${sortBy}&sortOrder=${sortOrder}`),
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error("Failed to fetch groups");
      }

      const data = await response.json();
      const validation = z.array(GroupChatSchema).safeParse(data.data.groups);
      if (!validation.success) {
        throw new Error("Invalid group data structure");
      }
      setGroups(validation.data || []);
      setIsLoading(false);
    });
  }, [sortBy, sortOrder]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  const filteredGroups = groups.filter(
    (group) =>
      group.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      group.creatorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      group.id.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const getGroupTypeLabel = (type: string) => {
    switch (type) {
      case "npc-only":
      case "npc":
        return "NPC Only";
      case "npc-mixed":
        return "NPC + Users";
      case "user":
        return "User Created";
      case "agent":
        return "Agent Group";
      case "team":
        return "Agents";
      default:
        return "Unknown";
    }
  };

  const getGroupTypeColor = (type: string) => {
    switch (type) {
      case "npc-only":
      case "npc":
        return "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20";
      case "npc-mixed":
        return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
      case "user":
        return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20";
      case "agent":
        return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
      case "team":
        return "bg-primary/10 text-primary border-primary/20";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-xl">Group Chats</h2>
          <span className="text-muted-foreground text-sm">
            ({filteredGroups.length}{" "}
            {filteredGroups.length === 1 ? "group" : "groups"})
          </span>
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

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search groups by name, creator, or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={cn(
              "w-full rounded-lg border border-border py-2 pr-4 pl-10",
              "bg-background text-foreground",
              "focus:border-primary focus:outline-none",
            )}
          />
        </div>

        {/* Sort */}
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
            title={sortOrder === "asc" ? "Ascending" : "Descending"}
          >
            {sortOrder === "asc" ? "↑" : "↓"}
          </button>
        </div>
      </div>

      {/* Groups List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Users className="mx-auto mb-4 h-12 w-12 opacity-50" />
          <p>No group chats found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filteredGroups.map((group) => (
            <div
              key={group.id}
              className={cn(
                "space-y-3 rounded-lg border border-border bg-card p-4",
                "cursor-pointer transition-colors hover:border-primary",
                selectedGroup?.id === group.id && "border-primary",
              )}
              onClick={() => setSelectedGroup(group)}
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold">
                    {group.name || "Unnamed Group"}
                  </h3>
                  <p className="text-muted-foreground text-xs">
                    ID: {group.id}
                  </p>
                </div>
                <span
                  className={cn(
                    "whitespace-nowrap rounded border px-2 py-1 font-medium text-xs",
                    getGroupTypeColor(group.groupType),
                  )}
                >
                  {getGroupTypeLabel(group.groupType)}
                </span>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1">
                  <UserIcon className="h-4 w-4 text-muted-foreground" />
                  <span>{group.memberCount} members</span>
                </div>
                <div className="flex items-center gap-1">
                  <MessageCircle className="h-4 w-4 text-muted-foreground" />
                  <span>{group.messageCount} messages</span>
                </div>
              </div>

              {/* Creator */}
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Creator:</span>
                <span className="font-medium">{group.creatorName}</span>
              </div>

              {/* Dates */}
              <div className="flex items-center gap-1 text-muted-foreground text-xs">
                <Calendar className="h-3 w-3" />
                <span>
                  Created {new Date(group.createdAt).toLocaleDateString()}
                </span>
              </div>

              {/* Participants Preview */}
              <div className="border-border border-t pt-2">
                <p className="mb-2 text-muted-foreground text-xs">
                  Participants:
                </p>
                <div className="flex flex-wrap gap-1">
                  {group.participants.slice(0, 5).map((participant) => (
                    <span
                      key={participant.id}
                      className={cn(
                        "rounded px-2 py-1 text-xs",
                        participant.isNPC
                          ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                          : "bg-muted text-foreground",
                      )}
                    >
                      {participant.name}
                    </span>
                  ))}
                  {group.participants.length > 5 && (
                    <span className="rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
                      +{group.participants.length - 5} more
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected Group Details */}
      {selectedGroup && (
        <div className="space-y-4 rounded-lg border border-primary bg-card p-6">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg">Group Details</h3>
            <button
              onClick={() => setSelectedGroup(null)}
              className="text-muted-foreground text-sm hover:text-foreground"
            >
              Close
            </button>
          </div>

          {/* Full Participant List */}
          <div>
            <h4 className="mb-2 font-medium">
              All Participants ({selectedGroup.memberCount})
            </h4>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {selectedGroup.participants.map((participant) => (
                <div
                  key={participant.id}
                  className="flex items-center justify-between rounded bg-muted/50 p-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{participant.name}</span>
                    {participant.isNPC && (
                      <span className="rounded bg-purple-500/10 px-2 py-0.5 text-purple-600 text-xs dark:text-purple-400">
                        NPC
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    Joined {new Date(participant.joinedAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Messages */}
          {selectedGroup.recentMessages.length > 0 && (
            <div>
              <h4 className="mb-2 font-medium">Recent Messages</h4>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {selectedGroup.recentMessages.map((message) => (
                  <div
                    key={message.id}
                    className="space-y-1 rounded bg-muted/50 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">
                        {message.sender.name}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {new Date(message.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-sm">{message.content}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
