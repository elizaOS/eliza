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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  StatusBadge,
  Switch,
} from "@elizaos/cloud-ui";
import Image from "@elizaos/cloud-ui";
import {
  Copy,
  Globe,
  Link as LinkIcon,
  Lock,
  MoreHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import * as React from "react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useChatStore } from "@/lib/stores/chat-store";
import { cn } from "@/lib/utils";
import { ensureAvatarUrl, isBuiltInAvatar } from "@/lib/utils/default-avatar";

export interface AgentCardData {
  id: string;
  name: string;
  bio?: string | string[];
  avatarUrl?: string | null;
  avatar_url?: string | null;
  username?: string | null;
  isPublic?: boolean;
  is_public?: boolean;
  category?: string | null;
  stats?: {
    deploymentStatus?: "deployed" | "stopped" | "pending" | "draft" | null;
    roomCount?: number;
    messageCount?: number;
    lastActiveAt?: Date | string | null;
  };
  // For saved agents
  isOwned?: boolean;
  ownerUsername?: string;
  lastInteraction?: string;
  updated_at?: string;
  created_at?: string;
}

export type ViewMode = "grid" | "list";

interface AgentCardProps {
  agent: AgentCardData;
  /** View mode - grid (square cards) or list (horizontal) */
  viewMode?: ViewMode;
  /** Show deployment status badges (Live/Stopped) */
  showDeploymentStatus?: boolean;
  /** Callback when a saved agent is removed */
  onRemoveSaved?: (agentId: string) => void;
}

export function AgentCard({
  agent,
  viewMode = "grid",
  showDeploymentStatus = false,
  onRemoveSaved,
}: AgentCardProps) {
  const navigate = useNavigate();
  const { loadRooms, rooms } = useChatStore();

  const bioText = Array.isArray(agent.bio) ? agent.bio[0] : agent.bio;
  const avatarUrl = agent.avatarUrl || agent.avatar_url;
  const isOwned = agent.isOwned !== false; // Default to true if not specified
  const initialIsPublic = agent.isPublic ?? agent.is_public ?? false;

  const isDeployed = agent.stats?.deploymentStatus === "deployed";
  const isStopped = agent.stats?.deploymentStatus === "stopped";

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [isHovered, setIsHovered] = useState(false);

  const handleDuplicate = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropdownOpen(false);

      toast.info("Duplicating agent...");

      try {
        const response = await fetch(`/api/my-agents/characters/${agent.id}/clone`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `${agent.name} (Copy)` }),
        });

        if (response.ok) {
          const data = await response.json();
          toast.success(`Created "${data.data.character.name}"`);
          window.dispatchEvent(new Event("characters-updated"));
          navigate(`/dashboard/chat?characterId=${data.data.character.id}`);
        } else {
          const error = await response.json();
          toast.error(error.error || "Failed to duplicate agent");
        }
      } catch {
        toast.error("Failed to duplicate agent");
      }
    },
    [agent.id, agent.name, navigate],
  );

  const handleExport = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropdownOpen(false);

      const dataStr = JSON.stringify(agent, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${agent.name || "agent"}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Agent exported successfully");
    },
    [agent],
  );

  const handleToggleShare = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const newIsPublic = !isPublic;
      setIsPublic(newIsPublic);

      try {
        const response = await fetch(`/api/my-agents/characters/${agent.id}/share`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isPublic: newIsPublic }),
        });

        if (response.ok) {
          toast.success(newIsPublic ? "Agent is now public" : "Agent is now private");
        } else {
          setIsPublic(!newIsPublic);
          toast.error("Failed to update sharing");
        }
      } catch {
        setIsPublic(!newIsPublic);
        toast.error("Failed to update sharing");
      }
    },
    [agent.id, isPublic],
  );

  const handleCopyShareLink = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropdownOpen(false);

      if (!agent.username) {
        toast.error("Set a username first to share this agent");
        return;
      }
      const shareUrl = `${window.location.origin}/chat/@${agent.username}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        toast.success("Share link copied!");
      } catch {
        toast.error("Failed to copy link to clipboard");
      }
    },
    [agent.username],
  );

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropdownOpen(false);
    setShowDeleteConfirm(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    setIsDeleting(true);

    const response = await fetch(`/api/my-agents/characters/${agent.id}`, {
      method: "DELETE",
    });

    if (response.ok) {
      toast.success("Agent deleted");
      setShowDeleteConfirm(false);
      window.dispatchEvent(new Event("characters-updated"));
      window.location.reload();
    } else {
      toast.error("Failed to delete agent");
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [agent.id]);

  const handleCancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
  }, []);

  const handleRemoveSaved = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropdownOpen(false);

      try {
        const response = await fetch(`/api/my-agents/saved/${agent.id}`, {
          method: "DELETE",
        });

        if (response.ok) {
          toast.success(`Removed ${agent.name} from saved agents`);
          onRemoveSaved?.(agent.id);
          window.dispatchEvent(new Event("characters-updated"));
          window.location.reload();
        } else {
          const error = await response.json();
          toast.error(error.error || "Failed to remove saved agent");
        }
      } catch {
        toast.error("Failed to remove saved agent");
      }
    },
    [agent.id, agent.name, onRemoveSaved],
  );

  const openAgentChat = useCallback(async () => {
    // Ensure rooms are loaded
    if (rooms.length === 0) {
      await loadRooms();
    }

    const currentRooms = useChatStore.getState().rooms;
    const characterRooms = currentRooms
      .filter((r) => r.characterId === agent.id)
      .sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));

    if (characterRooms.length > 0) {
      navigate(`/dashboard/chat?characterId=${agent.id}&roomId=${characterRooms[0].id}`);
    } else {
      navigate(`/dashboard/chat?characterId=${agent.id}`);
    }
  }, [rooms.length, loadRooms, agent.id, navigate]);

  const handleCardClick = useCallback(
    (e: React.MouseEvent) => {
      if (showDeleteConfirm) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      void openAgentChat();
    },
    [showDeleteConfirm, openAgentChat],
  );

  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!showDeleteConfirm) {
          void openAgentChat();
        }
      }
    },
    [showDeleteConfirm, openAgentChat],
  );

  const isListView = viewMode === "list";

  // List view
  if (isListView) {
    return (
      <div
        className={cn("min-w-0", !showDeleteConfirm && "cursor-pointer")}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        role="button"
        tabIndex={0}
      >
        <div className="group relative overflow-hidden rounded-xl bg-white/5 border border-white/10 transition-all duration-300 hover:border-white/20 hover:bg-white/[0.07]">
          <div className="flex items-center gap-4 p-4">
            {/* Avatar */}
            <div className="relative flex-shrink-0 w-12 h-12 overflow-hidden rounded-lg">
              <Skeleton className="absolute inset-0 w-full h-full" />
              <Image
                src={ensureAvatarUrl(avatarUrl, agent.name)}
                alt={agent.name}
                fill
                className="object-cover"
                unoptimized={!isBuiltInAvatar(ensureAvatarUrl(avatarUrl, agent.name))}
              />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 overflow-hidden">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white truncate">
                  {agent.name || "Unnamed Agent"}
                </h3>
                {!isPublic && isOwned && (
                  <Lock className="h-3.5 w-3.5 text-white/50 flex-shrink-0" />
                )}
                {!isOwned && (
                  <span className="text-xs text-white/50 flex-shrink-0">
                    by @{agent.ownerUsername || "unknown"}
                  </span>
                )}
              </div>
              <p className="text-sm text-white/50 truncate">{bioText || "No description"}</p>
            </div>

            {/* Status badges */}
            {showDeploymentStatus && (
              <div className="flex gap-1.5 flex-shrink-0">
                {isDeployed && (
                  <StatusBadge
                    status="success"
                    label="Live"
                    pulse
                    className="px-2 py-0.5 text-[10px]"
                  />
                )}
                {isStopped && (
                  <StatusBadge
                    status="warning"
                    label="Stopped"
                    className="px-2 py-0.5 text-[10px]"
                  />
                )}
              </div>
            )}

            {/* Remove button for saved agents */}
            {!isOwned && isHovered && (
              <button
                type="button"
                onClick={handleRemoveSaved}
                className="flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg bg-transparent hover:bg-red-500/20 transition-colors"
                title="Remove from saved"
              >
                <X className="h-4 w-4 text-white/70 hover:text-red-500" />
              </button>
            )}

            {/* Dropdown Menu */}
            <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
              <DropdownMenuTrigger
                className="flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg bg-transparent hover:bg-white/10 transition-colors"
                onClick={(e) => e.preventDefault()}
              >
                <MoreHorizontal className="h-4 w-4 text-white" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {isOwned ? (
                  <>
                    <DropdownMenuItem onClick={handleDuplicate} className="cursor-pointer">
                      <Copy className="h-4 w-4 mr-2" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleExport} className="cursor-pointer">
                      <Upload className="h-4 w-4 mr-2" />
                      Export JSON
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleToggleShare}
                      className="cursor-pointer flex items-center justify-between"
                    >
                      <span className="flex items-center">
                        {isPublic ? (
                          <Globe className="h-4 w-4 mr-4 text-green-500" />
                        ) : (
                          <Lock className="h-4 w-4 mr-4" />
                        )}
                        {isPublic ? "Public" : "Private"}
                      </span>
                      <Switch
                        checked={isPublic}
                        className="pointer-events-none data-[state=checked]:bg-green-500/20 [&_[data-slot=switch-thumb]]:data-[state=checked]:bg-green-500 [&_[data-slot=switch-thumb]]:data-[state=unchecked]:bg-white/40"
                      />
                    </DropdownMenuItem>
                    {isPublic && (
                      <DropdownMenuItem onClick={handleCopyShareLink} className="cursor-pointer">
                        <LinkIcon className="h-4 w-4 mr-2" />
                        Share
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleDeleteClick}
                      className="cursor-pointer text-red-500 bg-red-500/10 hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-500"
                    >
                      <Trash2 className="h-4 w-4 mr-2 text-red-500" />
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : (
                  <>
                    <DropdownMenuItem onClick={handleDuplicate} className="cursor-pointer">
                      <Copy className="h-4 w-4 mr-2" />
                      Fork Agent
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleRemoveSaved}
                      className="cursor-pointer text-red-500 bg-red-500/10 hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-500"
                    >
                      <X className="h-4 w-4 mr-2 text-red-500" />
                      Remove
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Delete Confirmation */}
          <AlertDialog
            open={showDeleteConfirm}
            onOpenChange={(open) => !open && handleCancelDelete()}
          >
            <AlertDialogContent onClick={(e) => e.stopPropagation()}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Agent</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete{" "}
                  <span className="font-semibold text-white">{agent.name}</span>? This action cannot
                  be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleConfirmDelete}
                  disabled={isDeleting}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {isDeleting ? "Deleting..." : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    );
  }

  // Grid view (default)
  return (
    <div
      className={cn("block h-full", !showDeleteConfirm && "cursor-pointer")}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="button"
      tabIndex={0}
    >
      <div className="group relative aspect-square w-full overflow-hidden rounded-xl">
        <Skeleton className="absolute inset-0 w-full h-full" />

        <Image
          src={ensureAvatarUrl(avatarUrl, agent.name)}
          alt={agent.name}
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
          className={cn(
            "object-cover transition-transform duration-500",
            !showDeleteConfirm && "group-hover:scale-105",
          )}
          priority
          unoptimized={!isBuiltInAvatar(ensureAvatarUrl(avatarUrl, agent.name))}
        />

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />

        {/* Top left badges */}
        <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
          {!isPublic && isOwned && (
            <div className="bg-black/30 rounded-md p-1.5">
              <Lock className=" h-4 w-4 text-white/70" />
            </div>
          )}
          {!isOwned && (
            <span className="text-xs text-white/70 bg-black/30 px-2 py-0.5 rounded-md">
              by @{agent.ownerUsername || "unknown"}
            </span>
          )}
          {showDeploymentStatus && isDeployed && (
            <StatusBadge status="success" label="Live" pulse className="px-2 py-0.5 text-[10px]" />
          )}
          {showDeploymentStatus && isStopped && (
            <StatusBadge status="warning" label="Stopped" className="px-2 py-0.5 text-[10px]" />
          )}
        </div>

        {/* Remove button for saved agents */}
        {!isOwned && isHovered && (
          <button
            type="button"
            onClick={handleRemoveSaved}
            className="absolute top-3 right-12 z-20 flex items-center justify-center h-9 w-9 rounded-lg bg-black/30 hover:bg-red-500/50 transition-colors"
            title="Remove from saved"
          >
            <X className="h-4 w-4 text-white" />
          </button>
        )}

        {/* Dropdown Menu */}
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger className="absolute top-3 right-3 z-20 flex items-center justify-center h-9 w-9 rounded-lg bg-black/30 hover:bg-black/50 transition-colors">
            <MoreHorizontal className="h-4 w-4 text-white" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            {isOwned ? (
              <>
                <DropdownMenuItem onClick={handleDuplicate} className="cursor-pointer">
                  <Copy className="h-4 w-4 mr-2" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExport} className="cursor-pointer">
                  <Upload className="h-4 w-4 mr-2" />
                  Export JSON
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleToggleShare}
                  className="cursor-pointer flex items-center justify-between"
                >
                  <span className="flex items-center">
                    {isPublic ? (
                      <Globe className="h-4 w-4 mr-4 text-green-500" />
                    ) : (
                      <Lock className="h-4 w-4 mr-4" />
                    )}
                    {isPublic ? "Public" : "Private"}
                  </span>
                  <Switch
                    checked={isPublic}
                    className="pointer-events-none data-[state=checked]:bg-green-500/20 [&_[data-slot=switch-thumb]]:data-[state=checked]:bg-green-500 [&_[data-slot=switch-thumb]]:data-[state=unchecked]:bg-white/40"
                  />
                </DropdownMenuItem>
                {isPublic && (
                  <DropdownMenuItem onClick={handleCopyShareLink} className="cursor-pointer">
                    <LinkIcon className="h-4 w-4 mr-2" />
                    Share
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleDeleteClick}
                  className="cursor-pointer text-red-500 bg-red-500/10 hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-500"
                >
                  <Trash2 className="h-4 w-4 mr-2 text-red-500" />
                  Delete
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={handleDuplicate} className="cursor-pointer">
                  <Copy className="h-4 w-4 mr-2" />
                  Fork Agent
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleRemoveSaved}
                  className="cursor-pointer text-red-500 bg-red-500/10 hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-500"
                >
                  <X className="h-4 w-4 mr-2 text-red-500" />
                  Remove
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Name and Bio overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-3 z-10">
          <h3 className="font-semibold text-white truncate">{agent.name}</h3>
          <p className="text-xs text-white/70 line-clamp-2 leading-relaxed">
            {bioText || "No description"}
          </p>
        </div>

        {/* Delete Confirmation */}
        <AlertDialog
          open={showDeleteConfirm}
          onOpenChange={(open) => !open && handleCancelDelete()}
        >
          <AlertDialogContent onClick={(e) => e.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Agent</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete{" "}
                <span className="font-semibold text-white">{agent.name}</span>? This action cannot
                be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
