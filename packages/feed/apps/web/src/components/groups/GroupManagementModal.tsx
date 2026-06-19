"use client";

import { cn, logger } from "@feed/shared";
import {
  Crown,
  Loader2,
  LogOut,
  Search,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { useAuth } from "@/hooks/useAuth";
import { useAuthStore } from "@/stores/authStore";
import { apiUrl } from "@/utils/api-url";
import { GroupTypeBadge } from "./MemberTypeBadge";

/**
 * Member structure for group management modal.
 *
 * Role model: `role` is the canonical field.
 * - `isAdmin` is derived: `role === 'admin' || role === 'owner'`
 * - `isOwner` is derived: `role === 'owner'`
 * Invariant: `isOwner === true` implies `isAdmin === true`.
 */
interface Member {
  id: string;
  displayName: string | null;
  username: string | null;
  profileImageUrl: string | null;
  memberType: "user" | "agent" | "npc";
  role: "owner" | "admin" | "member";
  isAdmin: boolean;
  isOwner: boolean;
  joinedAt: Date | string;
}

/**
 * Group details structure for group management modal.
 *
 * `userRole`, `isAdmin`, and `isOwner` reflect the current user's role.
 * See {@link Member} for the role model invariants.
 */
interface GroupDetails {
  id: string;
  name: string;
  description: string | null;
  type: "user" | "npc" | "agent" | "team";
  members: Member[];
  userRole: "owner" | "admin" | "member";
  isAdmin: boolean;
  isOwner: boolean;
}

/**
 * Search result for adding members
 */
interface SearchResult {
  id: string;
  displayName: string | null;
  username: string | null;
  profileImageUrl: string | null;
  type: "user" | "agent";
}

/**
 * Group management modal component for managing group members and settings.
 *
 * Provides comprehensive group management interface including member list,
 * adding/removing members via user search (including user-created agents),
 * promoting/demoting admins, and deleting groups.
 *
 * Features:
 * - Member list display with type badges
 * - User search for adding members (includes human users and user-created agents)
 * - Remove member functionality
 * - Promote/demote admin functionality
 * - Delete group functionality
 * - Leave group functionality
 * - Confirmation dialogs
 * - Loading states
 * - Error handling
 */
interface GroupManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string | null;
  onGroupUpdated?: () => void;
  /** Called after the user leaves or deletes the group (clears selection). */
  onGroupRemoved?: () => void;
}

export function GroupManagementModal({
  isOpen,
  onClose,
  groupId,
  onGroupUpdated,
  onGroupRemoved,
}: GroupManagementModalProps) {
  const { getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const [groupDetails, setGroupDetails] = useState<GroupDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Group info state
  const [isEditingGroupName, setIsEditingGroupName] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");

  const secondaryBtnClass =
    "rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-sm transition-colors hover:bg-accent disabled:opacity-50";

  const resetGroupNameEdit = () => {
    setError(null);
    if (groupDetails) setGroupNameDraft(groupDetails.name);
  };

  // Add member state
  const [showAddMember, setShowAddMember] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Confirm dialogs
  const [confirmAction, setConfirmAction] = useState<{
    type: "remove" | "promote" | "demote" | "delete" | "leave";
    userId?: string;
    userName?: string;
  } | null>(null);

  // Load group details
  useEffect(() => {
    if (!isOpen || !groupId) {
      setGroupDetails(null);
      setError(null);
      setIsEditingGroupName(false);
      setGroupNameDraft("");
      setShowAddMember(false);
      setSearchQuery("");
      setSearchResults([]);
      return;
    }

    const loadGroupDetails = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getAccessToken();
        const response = await fetch(apiUrl(`/api/groups/${groupId}`), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          setError("Failed to load group details");
          return;
        }

        const data = await response.json();
        setGroupDetails(data.group);
        setGroupNameDraft(data.group?.name || "");
        setIsEditingGroupName(false);
      } catch (err) {
        logger.error(
          "Failed to load group details",
          err instanceof Error ? err : { error: err },
          "GroupManagementModal",
        );
        setError("Failed to load group details. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    loadGroupDetails();
  }, [isOpen, groupId, getAccessToken]);

  const handleUpdateGroupName = async () => {
    if (!groupId) return;

    const nextName = groupNameDraft.trim();
    if (!nextName) {
      setError("Group name is required");
      return;
    }
    if (nextName.length > 100) {
      setError("Group name must be 100 characters or less");
      return;
    }

    setActionLoading("group-name");
    setError(null);

    try {
      const token = await getAccessToken();
      const response = await fetch(`/api/groups/${groupId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: nextName }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || "Failed to update group name");
        return;
      }

      // Reload group details so member/admin flags stay consistent.
      try {
        const detailsResponse = await fetch(`/api/groups/${groupId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (detailsResponse.ok) {
          const data = await detailsResponse.json();
          setGroupDetails(data.group);
          setGroupNameDraft(data.group?.name || nextName);
        } else {
          // PATCH succeeded; optimistically update UI with the new name
          setGroupDetails((prev) =>
            prev ? { ...prev, name: nextName } : prev,
          );
          setGroupNameDraft(nextName);
        }
      } catch {
        // Reload failed but PATCH succeeded; apply optimistic update
        setGroupDetails((prev) => (prev ? { ...prev, name: nextName } : prev));
        setGroupNameDraft(nextName);
      }

      setIsEditingGroupName(false);
      onGroupUpdated?.();
    } catch (err) {
      logger.error(
        "Failed to update group name",
        err instanceof Error ? err : { error: err },
        "GroupManagementModal",
      );
      setError("Network error. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  // Search for users (including user-created agents)
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    const searchMembers = async () => {
      setSearching(true);
      try {
        const token = await getAccessToken();

        const response = await fetch(
          `/api/users/search?q=${encodeURIComponent(searchQuery)}&includeAgents=true`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        if (response.ok) {
          const data = await response.json();
          const existingMemberIds =
            groupDetails?.members.map((m) => m.id) || [];

          const results: SearchResult[] = (data.users || [])
            .filter((u: { id: string }) => !existingMemberIds.includes(u.id))
            .map(
              (u: {
                id: string;
                displayName: string | null;
                username: string | null;
                profileImageUrl: string | null;
                isAgent?: boolean;
              }) => ({
                id: u.id,
                displayName: u.displayName,
                username: u.username,
                profileImageUrl: u.profileImageUrl,
                type: u.isAgent ? ("agent" as const) : ("user" as const),
              }),
            );
          setSearchResults(results);
        } else {
          setSearchResults([]);
        }
      } catch (error) {
        logger.error(
          "Member search failed",
          error instanceof Error ? error : { error },
          "GroupManagementModal",
        );
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    };

    const debounce = setTimeout(searchMembers, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, getAccessToken, groupDetails]);

  const handleAddMember = async (userId: string) => {
    if (!groupId) return;

    setActionLoading(userId);
    setError(null);

    try {
      const token = await getAccessToken();
      const response = await fetch(apiUrl(`/api/groups/${groupId}/members`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Failed to add member");
        return;
      }

      await response.json();

      // Reload group details
      const detailsResponse = await fetch(apiUrl(`/api/groups/${groupId}`), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (detailsResponse.ok) {
        const data = await detailsResponse.json();
        setGroupDetails(data.group);
      }

      setSearchQuery("");
      setSearchResults([]);
      onGroupUpdated?.();
    } catch (err) {
      logger.error(
        "Failed to add member",
        err instanceof Error ? err : { error: err },
        "GroupManagementModal",
      );
      setError("Network error. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!groupId) return;

    setActionLoading(userId);
    setError(null);
    const token = await getAccessToken();
    const response = await fetch(
      `/api/groups/${groupId}/members?userId=${userId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const data = await response.json();
      setError(data.error || "Failed to remove member");
      setActionLoading(null);
      setConfirmAction(null);
      return;
    }

    // Reload group details
    const detailsResponse = await fetch(apiUrl(`/api/groups/${groupId}`), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (detailsResponse.ok) {
      const data = await detailsResponse.json();
      setGroupDetails(data.group);
    }

    onGroupUpdated?.();
    setActionLoading(null);
    setConfirmAction(null);
  };

  const handlePromoteToAdmin = async (userId: string) => {
    if (!groupId) return;

    setActionLoading(userId);
    setError(null);
    const token = await getAccessToken();
    const response = await fetch(apiUrl(`/api/groups/${groupId}/admins`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const data = await response.json();
      setError(data.error || "Failed to promote member");
      setActionLoading(null);
      setConfirmAction(null);
      return;
    }

    // Reload group details
    const detailsResponse = await fetch(apiUrl(`/api/groups/${groupId}`), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (detailsResponse.ok) {
      const data = await detailsResponse.json();
      setGroupDetails(data.group);
    }

    onGroupUpdated?.();
    setActionLoading(null);
    setConfirmAction(null);
  };

  const handleDemoteAdmin = async (userId: string) => {
    if (!groupId) return;

    setActionLoading(userId);
    setError(null);
    const token = await getAccessToken();
    const response = await fetch(
      `/api/groups/${groupId}/admins?userId=${userId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const data = await response.json();
      setError(data.error || "Failed to remove admin status");
      setActionLoading(null);
      setConfirmAction(null);
      return;
    }

    // Reload group details
    const detailsResponse = await fetch(apiUrl(`/api/groups/${groupId}`), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (detailsResponse.ok) {
      const data = await detailsResponse.json();
      setGroupDetails(data.group);
    }

    onGroupUpdated?.();
    setActionLoading(null);
    setConfirmAction(null);
  };

  const handleDeleteGroup = async () => {
    if (!groupId) return;

    setActionLoading("delete");
    setError(null);
    const token = await getAccessToken();
    const response = await fetch(apiUrl(`/api/groups/${groupId}`), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const data = await response.json();
      setError(data.error || "Failed to delete group");
      setActionLoading(null);
      setConfirmAction(null);
      return;
    }

    onGroupRemoved?.();
    onClose();
  };

  const handleLeaveGroup = async () => {
    if (!groupId || !user) return;

    setActionLoading("leave");
    setError(null);
    const token = await getAccessToken();
    const response = await fetch(
      `/api/groups/${groupId}/members?userId=${user.id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const data = await response.json();
      setError(data.error || "Failed to leave group");
      setActionLoading(null);
      setConfirmAction(null);
      return;
    }

    onGroupRemoved?.();
    onClose();
  };

  const handleConfirmAction = () => {
    if (!confirmAction) return;

    switch (confirmAction.type) {
      case "remove":
        if (confirmAction.userId) handleRemoveMember(confirmAction.userId);
        break;
      case "promote":
        if (confirmAction.userId) handlePromoteToAdmin(confirmAction.userId);
        break;
      case "demote":
        if (confirmAction.userId) handleDemoteAdmin(confirmAction.userId);
        break;
      case "delete":
        handleDeleteGroup();
        break;
      case "leave":
        handleLeaveGroup();
        break;
    }
  };

  if (!isOpen || !groupId) return null;

  const handleClose = () => {
    if (actionLoading) return; // Prevent closing during actions
    onClose();
  };

  // NPC groups cannot have members added via this modal
  const isNpcGroup = groupDetails?.type === "npc";

  return (
    <>
      <div
        className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm md:p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            handleClose();
          }
        }}
      >
        <div
          className="flex h-full w-full flex-col bg-background md:h-auto md:max-h-[85vh] md:w-auto md:min-w-[480px] md:max-w-lg md:rounded-xl md:border md:border-border md:shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex shrink-0 items-start justify-between border-border border-b px-6 py-4">
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-bold text-xl">
                {groupDetails?.name || "Group Settings"}
              </h2>
              {groupDetails && (
                <div className="mt-1">
                  <GroupTypeBadge type={groupDetails.type} />
                </div>
              )}
            </div>
            <button
              onClick={handleClose}
              className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              disabled={!!actionLoading}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
            {error && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3">
                <p className="text-red-500 text-sm">{error}</p>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : groupDetails ? (
              <div className="space-y-4">
                {/* Action Buttons */}
                <div className="flex justify-end gap-2">
                  {/* Leave Group (everyone can do this) */}
                  {!groupDetails.isOwner && (
                    <button
                      onClick={() => setConfirmAction({ type: "leave" })}
                      disabled={!!actionLoading}
                      className="rounded-lg border border-red-500 px-4 py-2 font-medium text-red-500 text-sm transition-colors hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <LogOut className="mr-2 inline h-4 w-4" />
                      Leave Group
                    </button>
                  )}

                  {/* Delete Group (owner only, not for NPC groups) */}
                  {groupDetails.isOwner && !isNpcGroup && (
                    <button
                      onClick={() => setConfirmAction({ type: "delete" })}
                      disabled={!!actionLoading}
                      className="rounded-lg border border-red-500 px-4 py-2 font-medium text-red-500 text-sm transition-colors hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="mr-2 inline h-4 w-4" />
                      Delete Group
                    </button>
                  )}
                </div>

                {/* NPC Group Notice */}
                {isNpcGroup && (
                  <div className="rounded-lg border border-purple-500/20 bg-purple-500/10 p-3">
                    <p className="text-purple-700 text-sm dark:text-purple-300">
                      This is an NPC-controlled group. Member management is
                      handled by the tiered invitation system.
                    </p>
                  </div>
                )}

                {/* Group Name */}
                {!isNpcGroup && (
                  <div className="rounded-lg border border-border bg-sidebar p-3">
                    <div className="flex items-center justify-between gap-3">
                      <label
                        htmlFor="group-name-input"
                        className="block font-semibold text-sm"
                      >
                        Group name
                      </label>
                      {groupDetails.isAdmin && (
                        <div className="flex items-center gap-2">
                          {isEditingGroupName ? (
                            <>
                              <button
                                onClick={handleUpdateGroupName}
                                disabled={!!actionLoading}
                                className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
                              >
                                {actionLoading === "group-name" ? (
                                  <Loader2 className="inline h-4 w-4 animate-spin" />
                                ) : (
                                  "Save"
                                )}
                              </button>
                              <button
                                onClick={() => {
                                  resetGroupNameEdit();
                                  setIsEditingGroupName(false);
                                }}
                                disabled={!!actionLoading}
                                className={secondaryBtnClass}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                resetGroupNameEdit();
                                setIsEditingGroupName(true);
                              }}
                              disabled={!!actionLoading}
                              className={secondaryBtnClass}
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {isEditingGroupName ? (
                      <input
                        id="group-name-input"
                        type="text"
                        value={groupNameDraft}
                        onChange={(e) => setGroupNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleUpdateGroupName();
                          }
                          if (e.key === "Escape") {
                            resetGroupNameEdit();
                            setIsEditingGroupName(false);
                          }
                        }}
                        maxLength={100}
                        className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors focus:border-primary focus:outline-none"
                      />
                    ) : (
                      <p className="truncate text-sm">{groupDetails.name}</p>
                    )}
                  </div>
                )}

                {/* Members Section */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block font-semibold text-sm">
                      Members ({groupDetails.members.length})
                    </label>
                    {groupDetails.isAdmin && !isNpcGroup && (
                      <button
                        onClick={() => setShowAddMember(!showAddMember)}
                        className="rounded-lg border border-border bg-sidebar px-3 py-1.5 font-medium text-sm transition-colors hover:bg-accent"
                      >
                        {showAddMember ? (
                          <>
                            <X className="mr-1 inline h-4 w-4" />
                            Cancel
                          </>
                        ) : (
                          <>
                            <UserPlus className="mr-1 inline h-4 w-4" />
                            Add Member
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Add Member Section */}
                  {showAddMember && groupDetails.isAdmin && !isNpcGroup && (
                    <div className="space-y-3 rounded-lg border border-border bg-sidebar p-3">
                      {/* Search Input */}
                      <div className="relative">
                        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <input
                          type="text"
                          placeholder="Search users..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full rounded-lg border border-border bg-background py-2.5 pr-10 pl-9 transition-colors focus:border-primary focus:outline-none"
                        />
                        {searching && (
                          <Loader2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-primary" />
                        )}
                      </div>

                      {/* Search Results */}
                      {searchResults.length > 0 && (
                        <div className="max-h-[150px] overflow-hidden overflow-y-auto rounded-lg border border-border bg-background">
                          {searchResults.map((result) => (
                            <button
                              key={result.id}
                              onClick={() => handleAddMember(result.id)}
                              disabled={actionLoading === result.id}
                              className="flex w-full items-center gap-2 p-2.5 text-left transition-colors hover:bg-sidebar disabled:opacity-50"
                            >
                              <Avatar
                                id={result.id}
                                src={result.profileImageUrl || undefined}
                                name={
                                  result.username || result.displayName || "?"
                                }
                                type="user"
                                size="sm"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-medium text-sm">
                                  {result.displayName ||
                                    result.username ||
                                    "Unknown"}
                                </div>
                                {result.username && (
                                  <div className="truncate text-muted-foreground text-xs">
                                    @{result.username}
                                  </div>
                                )}
                              </div>
                              {actionLoading === result.id && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              )}
                            </button>
                          ))}
                        </div>
                      )}

                      {searchQuery.length >= 2 &&
                        searchResults.length === 0 &&
                        !searching && (
                          <div className="py-2 text-center text-muted-foreground text-sm">
                            No users found
                          </div>
                        )}
                    </div>
                  )}

                  {/* Members List */}
                  <div className="space-y-2">
                    {groupDetails.members.map((member) => {
                      const isOwner = member.isOwner;
                      return (
                        <div
                          key={member.id}
                          className="flex items-center gap-3 rounded-lg border border-border bg-sidebar p-3 transition-colors hover:bg-sidebar/80"
                        >
                          <Avatar
                            id={member.id}
                            src={member.profileImageUrl || undefined}
                            name={member.username || member.displayName || "?"}
                            type={
                              member.memberType === "npc" ? "actor" : "user"
                            }
                            size="md"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium text-sm">
                                {member.displayName ||
                                  member.username ||
                                  "Unknown"}
                              </span>
                              {isOwner && (
                                <Crown className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
                              )}
                              {member.isAdmin && (
                                <Shield className="h-3.5 w-3.5 shrink-0 text-primary" />
                              )}
                            </div>
                            {member.username && (
                              <div className="truncate text-muted-foreground text-xs">
                                @{member.username}
                              </div>
                            )}
                          </div>

                          {/* Actions (only for admins, not for creator, not for NPC groups) */}
                          {groupDetails.isAdmin && !isOwner && !isNpcGroup && (
                            <div className="flex items-center gap-1">
                              {!member.isAdmin ? (
                                <button
                                  onClick={() =>
                                    setConfirmAction({
                                      type: "promote",
                                      userId: member.id,
                                      userName:
                                        member.displayName ||
                                        member.username ||
                                        "this user",
                                    })
                                  }
                                  disabled={!!actionLoading}
                                  className="rounded-md p-2 transition-colors hover:bg-background disabled:opacity-50"
                                  title="Make Admin"
                                >
                                  <Shield className="h-4 w-4 text-primary" />
                                </button>
                              ) : (
                                <button
                                  onClick={() =>
                                    setConfirmAction({
                                      type: "demote",
                                      userId: member.id,
                                      userName:
                                        member.displayName ||
                                        member.username ||
                                        "this user",
                                    })
                                  }
                                  disabled={!!actionLoading}
                                  className="rounded-md p-2 transition-colors hover:bg-background disabled:opacity-50"
                                  title="Remove Admin"
                                >
                                  <Shield className="h-4 w-4 text-muted-foreground" />
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  setConfirmAction({
                                    type: "remove",
                                    userId: member.id,
                                    userName:
                                      member.displayName ||
                                      member.username ||
                                      "this user",
                                  })
                                }
                                disabled={!!actionLoading}
                                className="rounded-md p-2 transition-colors hover:bg-background disabled:opacity-50"
                                title="Remove Member"
                              >
                                <UserMinus className="h-4 w-4 text-red-500" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !actionLoading) {
              setConfirmAction(null);
            }
          }}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-4 p-6">
              <h3 className="font-semibold text-lg">
                {confirmAction.type === "delete" && "Delete Group?"}
                {confirmAction.type === "remove" && "Remove Member?"}
                {confirmAction.type === "promote" && "Make Admin?"}
                {confirmAction.type === "demote" && "Remove Admin?"}
                {confirmAction.type === "leave" && "Leave Group?"}
              </h3>
              <p className="text-muted-foreground text-sm">
                {confirmAction.type === "delete" &&
                  "This will permanently delete the group and all its data. This action cannot be undone."}
                {confirmAction.type === "remove" &&
                  `Remove ${confirmAction.userName} from this group? They can be re-added later.`}
                {confirmAction.type === "promote" &&
                  `Give ${confirmAction.userName} admin privileges? They will be able to manage members and settings.`}
                {confirmAction.type === "demote" &&
                  `Remove admin privileges from ${confirmAction.userName}? They will remain a regular member.`}
                {confirmAction.type === "leave" &&
                  "Are you sure you want to leave this group? You will need to be re-added to join again."}
              </p>

              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmAction(null)}
                  disabled={!!actionLoading}
                  className="flex-1 rounded-lg border border-border bg-sidebar px-4 py-2.5 transition-colors hover:bg-accent disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmAction}
                  disabled={!!actionLoading}
                  className={cn(
                    "flex-1 rounded-lg px-4 py-2.5 font-medium transition-colors disabled:opacity-50",
                    confirmAction.type === "delete" ||
                      confirmAction.type === "remove" ||
                      confirmAction.type === "leave"
                      ? "bg-red-500 text-primary-foreground hover:bg-red-600"
                      : "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                >
                  {actionLoading ? (
                    <Loader2 className="inline h-4 w-4 animate-spin" />
                  ) : (
                    "Confirm"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
