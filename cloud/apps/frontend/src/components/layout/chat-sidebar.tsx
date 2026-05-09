/**
 * Chat sidebar component for the /chat page displaying rooms and conversations.
 * Supports room creation, deletion, editing, and navigation.
 *
 * @param props - Chat sidebar configuration
 * @param props.className - Additional CSS classes
 * @param props.isOpen - Whether sidebar is open (mobile)
 * @param props.onToggle - Callback to toggle sidebar visibility
 */

"use client";

import { ElizaCloudLockup } from "@elizaos/cloud-ui/components/brand/eliza-cloud-lockup";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@elizaos/cloud-ui/components/dropdown-menu";
import { Switch } from "@elizaos/cloud-ui/components/switch";
import {
  Globe,
  Link as LinkIcon,
  Loader2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useChatStore } from "@/lib/stores/chat-store";
import { cn } from "@/lib/utils";
import { ElizaAvatar } from "../chat/eliza-avatar";
import { SidebarBottomPanel } from "./sidebar-bottom-panel";

interface ChatSidebarProps {
  className?: string;
  isOpen?: boolean;
  onToggle?: () => void;
}

function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

interface OperationState {
  deletingRoomId: string | null;
  isCreatingRoom: boolean;
  loadingRoomId: string | null;
}

export function ChatSidebar({ className, isOpen = false, onToggle }: ChatSidebarProps) {
  const navigate = useNavigate();
  const [isMobile, setIsMobile] = useState(false);

  const {
    rooms,
    roomId,
    setRoomId,
    isLoadingRooms,
    loadRooms,
    createRoom,
    deleteRoom,
    selectedCharacterId,
    availableCharacters,
    viewerState,
  } = useChatStore();

  // Check if user is the owner
  const isOwner = viewerState === "owner";

  const [operationState, setOperationState] = useState<OperationState>({
    deletingRoomId: null,
    isCreatingRoom: false,
    loadingRoomId: null,
  });

  // Share/visibility state
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [isTogglingShare, setIsTogglingShare] = useState(false);

  const updateOperation = useCallback((updates: Partial<OperationState>) => {
    setOperationState((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleCloseClick = () => {
    onToggle?.();
  };

  // Fetch share status when character changes
  useEffect(() => {
    if (!selectedCharacterId) {
      setIsPublic(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const fetchShareStatus = async () => {
      try {
        const res = await fetch(`/api/my-agents/characters/${selectedCharacterId}/share`, {
          signal: controller.signal,
        });

        if (cancelled) return;

        if (res.status === 403 || res.status === 404) {
          setIsPublic(null);
          return;
        }

        if (!res.ok) {
          setIsPublic(null);
          return;
        }

        const data = await res.json();
        if (!cancelled && data?.success) {
          setIsPublic(data.data.isPublic);
        } else if (!cancelled) {
          setIsPublic(null);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        if (!cancelled) {
          setIsPublic(null);
        }
      }
    };

    fetchShareStatus();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedCharacterId]);

  // Toggle share status
  const handleToggleShare = async () => {
    if (!selectedCharacterId || isPublic === null || isTogglingShare) return;

    const newIsPublic = !isPublic;
    setIsTogglingShare(true);
    setIsPublic(newIsPublic);

    try {
      const response = await fetch(`/api/my-agents/characters/${selectedCharacterId}/share`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: newIsPublic }),
      });

      if (response.ok) {
        toast.success(newIsPublic ? "Agent is now public" : "Agent is now private");
      } else {
        setIsPublic(!newIsPublic);
        toast.error("Failed to update visibility");
      }
    } catch {
      setIsPublic(!newIsPublic);
      toast.error("Failed to update visibility");
    } finally {
      setIsTogglingShare(false);
    }
  };

  // Copy share link
  const handleCopyShareLink = async () => {
    if (!selectedCharacterId) return;
    const character = availableCharacters.find((c) => c.id === selectedCharacterId);
    // Use username if available, otherwise fall back to character ID
    const shareUrl = character?.username
      ? `${window.location.origin}/chat/@${character.username}`
      : `${window.location.origin}/chat/${selectedCharacterId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied!");
    } catch {
      toast.error("Failed to copy link to clipboard");
    }
  };

  // Filter rooms by selected character
  const filteredRooms = useMemo(() => {
    // Default Eliza agent ID (same as in rooms/route.ts)
    const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";

    if (!selectedCharacterId) {
      // Show rooms with no character assignment OR default Eliza ID
      return rooms.filter((room) => !room.characterId || room.characterId === DEFAULT_AGENT_ID);
    }
    return rooms.filter((room) => room.characterId === selectedCharacterId);
  }, [rooms, selectedCharacterId]);

  // Find selected character details
  const selectedCharacter = availableCharacters.find((c) => c.id === selectedCharacterId);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkScreenSize();
    window.addEventListener("resize", checkScreenSize);
    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  // Load rooms on mount (loadRooms from Zustand is stable)
  useEffect(() => {
    loadRooms();
  }, [loadRooms]); // Only run on mount

  const handleNewChat = async () => {
    if (operationState.isCreatingRoom) return; // Prevent double-clicking

    updateOperation({ isCreatingRoom: true });
    // Create room with currently selected character
    const newRoomId = await createRoom(selectedCharacterId);
    if (newRoomId) {
      setRoomId(newRoomId);
      // Update URL with new room ID and current character
      const params = new URLSearchParams();
      params.set("roomId", newRoomId);
      if (selectedCharacterId) {
        params.set("characterId", selectedCharacterId);
      }
      navigate(`/dashboard/chat?${params.toString()}`);
    }
    updateOperation({ isCreatingRoom: false });
  };

  const handleSelectRoom = (selectedRoomId: string) => {
    // Show loading state on the button
    updateOperation({ loadingRoomId: selectedRoomId });
    setRoomId(selectedRoomId);
    // Update URL with selected room ID and current character
    const params = new URLSearchParams();
    params.set("roomId", selectedRoomId);
    if (selectedCharacterId) {
      params.set("characterId", selectedCharacterId);
    }
    navigate(`/dashboard/chat?${params.toString()}`);
  };

  // Clear loading state when roomId changes
  useEffect(() => {
    if (roomId && operationState.loadingRoomId && roomId === operationState.loadingRoomId) {
      // Small delay to show the loading state
      const timer = setTimeout(() => {
        updateOperation({ loadingRoomId: null });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [roomId, operationState.loadingRoomId, updateOperation]);

  const handleDeleteRoom = async (roomIdToDelete: string) => {
    updateOperation({ deletingRoomId: roomIdToDelete });
    await deleteRoom(roomIdToDelete);
    updateOperation({ deletingRoomId: null });

    // If the deleted room was the current room, clear URL params
    if (roomId === roomIdToDelete) {
      const params = new URLSearchParams();
      if (selectedCharacterId) {
        params.set("characterId", selectedCharacterId);
      }
      navigate(`/dashboard/chat?${params.toString()}`);
    }
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {isMobile && isOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onToggle} />
      )}

      {/* Sidebar Container — always w-72 on desktop */}
      <aside
        className={cn(
          "flex h-full flex-col border-r border-white/10 bg-black/50 transition-all duration-300 ease-in-out backdrop-blur-sm w-72 p-1.5",
          isMobile &&
            `fixed inset-y-0 left-0 z-50 ${isOpen ? "translate-x-0" : "-translate-x-full"}`,
          className,
        )}
      >
        {/* Header with Logo and Collapse Toggle */}
        <div className="relative flex h-14 mb-2 shrink-0 grow-0 items-center justify-between px-3">
          <Link to="/dashboard" className="flex items-center gap-2 hover:opacity-80 relative z-10">
            <ElizaCloudLockup
              logoClassName={isMobile ? "h-4" : "h-5"}
              textClassName="text-[9px] md:text-[10px]"
            />
          </Link>
          {/* Mobile Close Button */}
          {isMobile && onToggle && (
            <button
              onClick={handleCloseClick}
              className="relative z-10 border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10 focus:bg-white/10 focus:outline-none"
              aria-label="Close navigation"
            >
              <X className="h-4 w-4 text-white" />
            </button>
          )}
        </div>

        {/* Selected Character Info */}
        <div className="flex items-center h-10 gap-3 px-3">
          {selectedCharacter ? (
            <ElizaAvatar
              avatarUrl={selectedCharacter.avatarUrl}
              name={selectedCharacter.name}
              className="w-6 h-6 shrink-0"
              iconClassName="h-3 w-3"
              fallbackClassName="bg-[#FF5800]/10"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-[#FF5800]/20 border border-[#FF5800]/30 flex items-center justify-center shrink-0">
              <Plus className="h-3 w-3 text-[#FF5800]" />
            </div>
          )}
          <div className="flex flex-col flex-1 min-w-0">
            <div className="text-sm font-medium text-white truncate">
              {selectedCharacter?.name || "Create New Agent"}
            </div>
            {selectedCharacter && !isOwner && selectedCharacter.creatorUsername && (
              <span className="text-[10px] text-white/40 truncate">
                by @{selectedCharacter.creatorUsername}
              </span>
            )}
          </div>
          {/* Settings Dropdown - Owner only */}
          {selectedCharacter && isOwner && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="p-2 hover:bg-white/10 rounded-lg transition-colors">
                  <MoreHorizontal className="h-5 w-5 text-neutral-300" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-56 rounded-xl border-white/10 bg-[#1a1a1a] backdrop-blur-md p-1.5"
                align="end"
                side="bottom"
                sideOffset={8}
              >
                <DropdownMenuItem
                  asChild
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-white/80 hover:text-white hover:bg-white/10 focus:bg-white/10 cursor-pointer transition-colors"
                >
                  <a href={`/dashboard/build?characterId=${selectedCharacterId}`}>
                    <Wrench className="h-4 w-4" />
                    Edit Agent
                  </a>
                </DropdownMenuItem>
                {isPublic !== null && (
                  <div className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/10 transition-colors">
                    <div className="flex items-center gap-2">
                      {isPublic ? (
                        <Globe className="h-4 w-4 text-green-500" />
                      ) : (
                        <Lock className="h-4 w-4 text-white/60" />
                      )}
                      <span className="text-sm text-white/80">
                        {isPublic ? "Public" : "Private"}
                      </span>
                    </div>
                    <Switch
                      checked={isPublic}
                      onCheckedChange={handleToggleShare}
                      className="data-[state=checked]:bg-green-500/30 data-[state=unchecked]:bg-white/20 [&_span]:data-[state=checked]:bg-green-500 [&_span]:data-[state=unchecked]:bg-white/60"
                    />
                  </div>
                )}
                {isPublic && (
                  <DropdownMenuItem
                    onClick={handleCopyShareLink}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-white/80 hover:text-white hover:bg-white/10 focus:bg-white/10 cursor-pointer transition-colors"
                  >
                    <LinkIcon className="h-4 w-4" />
                    Copy Share Link
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Non-owner: Copy share link button only */}
          {selectedCharacter && !isOwner && selectedCharacter.username && (
            <button
              onClick={handleCopyShareLink}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              title="Copy share link"
            >
              <LinkIcon className="h-4 w-4 text-neutral-300" />
            </button>
          )}
        </div>

        {/* New Chat Button */}
        <div className="h-12 flex items-center mb-4 pr-3">
          <button
            onClick={handleNewChat}
            disabled={operationState.isCreatingRoom}
            className="flex items-center gap-3 w-full pl-3 rounded-lg text-white hover:bg-white/10 transition-colors disabled:opacity-50 h-10"
          >
            {operationState.isCreatingRoom ? (
              <div className="w-6 h-6 flex items-center justify-center shrink-0">
                <Loader2 className="h-4 w-4 text-white/70 animate-spin" />
              </div>
            ) : (
              <div className="w-6 h-6 rounded-full bg-[#FF5800] flex items-center justify-center shrink-0">
                <Plus className="size-4 text-white" strokeWidth={2.5} />
              </div>
            )}
            <span className="text-sm whitespace-nowrap">New chat</span>
          </button>
        </div>

        {/* Rooms/Conversations List */}
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          <div className="px-2 pb-2 text-xs text-white/50 whitespace-nowrap">
            Chats ({filteredRooms.length})
          </div>
          {isLoadingRooms && filteredRooms.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-white/40" />
            </div>
          ) : (
            <div className="space-y-1">
              {filteredRooms.map((room) => {
                const isDeleting = operationState.deletingRoomId === room.id;
                const isLoading = operationState.loadingRoomId === room.id;
                return (
                  <div
                    key={room.id}
                    className={cn(
                      "group relative w-full text-left rounded-lg transition-all duration-200",
                      "hover:bg-white/5",
                      roomId === room.id && "bg-white/10",
                      (isDeleting || isLoading) && "opacity-50 pointer-events-none",
                    )}
                  >
                    <div className="relative">
                      <button
                        onClick={() => handleSelectRoom(room.id)}
                        disabled={isDeleting || isLoading}
                        className="w-full text-left px-3 py-2.5"
                      >
                        {isLoading && (
                          <Loader2 className="h-3.5 w-3.5 text-white/70 absolute right-3 top-1/2 -translate-y-1/2 animate-spin" />
                        )}
                        <div className="flex items-center justify-between gap-1.5 overflow-hidden">
                          <span className="text-[13px] font-medium text-white/90 truncate whitespace-nowrap">
                            {room.title || "New Chat"}
                          </span>
                          {room.lastTime && !isLoading && (
                            <span className="text-[11px] text-white/30 shrink-0 whitespace-nowrap group-hover:opacity-0 transition-opacity duration-200">
                              {formatTimestamp(room.lastTime)}
                            </span>
                          )}
                        </div>
                      </button>
                      {/* Delete button */}
                      <div
                        className={cn(
                          "absolute top-0 right-0 h-full flex items-center",
                          "opacity-0 group-hover:opacity-100 transition-opacity duration-200",
                          "pr-1.5",
                        )}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteRoom(room.id);
                          }}
                          disabled={isDeleting}
                          className={cn(
                            "h-7 w-7 flex items-center justify-center rounded-md",
                            "hover:bg-red-500/20 text-white/60 hover:text-red-400",
                            "transition-colors duration-150",
                          )}
                        >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredRooms.length === 0 && !isLoadingRooms && (
                <div className="px-3 py-6 text-center">
                  <MessageSquare className="h-8 w-8 text-white/15 mx-auto mb-2" />
                  <p className="text-[10px] text-white/40">No chats yet</p>
                </div>
              )}
            </div>
          )}
        </nav>

        {/* User Settings Panel */}
        <SidebarBottomPanel />
      </aside>
    </>
  );
}
