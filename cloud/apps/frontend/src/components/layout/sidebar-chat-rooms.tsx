/**
 * Sidebar chat rooms section component displayed in sidebar on chat page.
 * Shows filtered rooms for selected character with creation and deletion support.
 */

"use client";

import { Loader2, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useChatStore } from "@/lib/stores/chat-store";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@elizaos/cloud-ui";
import { Button } from "@elizaos/cloud-ui";

export function SidebarChatRooms() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    rooms,
    roomId: selectedRoomId,
    isLoadingRooms,
    loadRooms,
    createRoom,
    deleteRoom,
    selectedCharacterId,
    availableCharacters,
  } = useChatStore();
  const [deleteRoomId, setDeleteRoomId] = useState<string | null>(null);

  // Load rooms on mount
  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  // Filter rooms by selected character
  const filteredRooms = selectedCharacterId
    ? rooms.filter((room) => room.characterId === selectedCharacterId)
    : rooms.filter((room) => !room.characterId);

  const formatTimestamp = (timestamp?: number): string => {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  const handleSelectRoom = (roomId: string) => {
    // Update URL with room ID (preserve character ID if present)
    const params = new URLSearchParams(searchParams.toString());
    params.set("roomId", roomId);
    navigate(`/dashboard/chat?${params.toString()}`);
  };

  const handleCreateRoom = async () => {
    const newRoomId = await createRoom(selectedCharacterId);
    if (newRoomId) {
      // Update URL with new room ID
      const params = new URLSearchParams(searchParams.toString());
      params.set("roomId", newRoomId);
      navigate(`/dashboard/chat?${params.toString()}`);
      toast.success("New conversation started");
    }
  };

  const handleDeleteRoom = (roomId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteRoomId(roomId);
  };

  const handleConfirmDelete = async () => {
    if (!deleteRoomId) return;
    const roomId = deleteRoomId;
    setDeleteRoomId(null);

    await deleteRoom(roomId);

    // If deleted room was selected, clear URL params
    if (roomId === selectedRoomId) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("roomId");
      const newUrl = params.toString() ? `/dashboard/chat?${params.toString()}` : "/dashboard/chat";
      navigate(newUrl);
    }

    toast.success("Conversation deleted");
  };

  const getCharacterName = (room: (typeof rooms)[0]) => {
    if (room.characterName) return room.characterName;
    if (!room.characterId) return "Default (Eliza)";
    const character = availableCharacters.find((c) => c.id === room.characterId);
    return character?.name || "Unknown";
  };

  return (
    <>
      <div className="space-y-2">
        {/* Header with Create Button */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: "#FF5800" }}
            />
            <h3 className="text-sm font-medium text-white">Conversations</h3>
          </div>
          <Button
            size="sm"
            onClick={handleCreateRoom}
            variant="ghost"
            className="h-6 w-6 p-0 hover:bg-white/10 text-white/60 hover:text-[#FF5800]"
            disabled={isLoadingRooms}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Room List */}
        <div className="space-y-1">
          {isLoadingRooms ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-white/40" />
            </div>
          ) : filteredRooms.length === 0 ? (
            <div className="py-4 px-2 text-center">
              <MessageSquare className="h-6 w-6 text-white/20 mx-auto mb-1" />
              <p className="text-xs text-white/40">No conversations</p>
            </div>
          ) : (
            filteredRooms.map((room) => (
              <button
                key={room.id}
                onClick={() => handleSelectRoom(room.id)}
                className={cn(
                  "group w-full text-left px-3 py-2 rounded-lg transition-colors",
                  "hover:bg-white/5",
                  selectedRoomId === room.id ? "bg-white/10 text-white" : "text-white/60",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-1">
                      <MessageSquare className="h-3 w-3 text-white/40 flex-shrink-0" />
                      <p className="text-xs text-white/60 truncate">{getCharacterName(room)}</p>
                    </div>
                    <p className="text-xs text-white/40 line-clamp-1 mb-1">
                      {room.title || "New Chat"}
                    </p>
                    {room.lastTime && (
                      <p className="text-xs text-white/30">{formatTimestamp(room.lastTime)}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => handleDeleteRoom(room.id, e)}
                    className={cn(
                      "h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0",
                      "hover:bg-red-500/20 hover:text-red-500",
                    )}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <AlertDialog
        open={deleteRoomId !== null}
        onOpenChange={(open) => !open && setDeleteRoomId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Conversation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this conversation? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
