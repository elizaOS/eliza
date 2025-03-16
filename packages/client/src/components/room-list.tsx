import { useState, useEffect } from "react";
import { ChannelType, type UUID, type Agent } from "@elizaos/core";
import {
  PlusCircle,
  Hash,
  MessageCircle,
  Settings,
  Trash2,
  Users,
  X,
  Plus,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgents } from "@/hooks/use-query-hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { useNavigate } from "react-router";

interface Room {
  id: string;
  name: string;
  type: ChannelType;
  entities: { id: string; agentId?: string }[];
}

interface RoomListProps {
  agentId: UUID;
  selectedRoomId?: UUID;
  onSelectRoom: (roomId: UUID) => void;
}

export function RoomList({
  agentId,
  selectedRoomId,
  onSelectRoom,
}: RoomListProps) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isParticipantsDialogOpen, setIsParticipantsDialogOpen] =
    useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomMembers, setNewRoomMembers] = useState<string[]>([]);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [availableAgents, setAvailableAgents] = useState<Agent[]>([]);
  const { data: agentsData } = useAgents();
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    fetchRooms();
    fetchAvailableAgents();
  }, [agentId]);

  const fetchRooms = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/agents/${agentId}/rooms`);
      const data = await response.json();
      if (data.success) {
        setRooms(data.data);
      } else {
        console.error("Failed to fetch rooms:", data.error);
        toast({
          variant: "destructive",
          title: "Error fetching rooms",
          description: data.error.message || "Unknown error occurred",
        });
      }
    } catch (error) {
      console.error("Error fetching rooms:", error);
      toast({
        variant: "destructive",
        title: "Error fetching rooms",
        description: "Could not connect to server",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAvailableAgents = async () => {
    try {
      const response = await fetch("/agents");
      const data = await response.json();
      if (data.success) {
        setAvailableAgents(
          data.data.agents.filter((agent: Agent) => agent.id !== agentId)
        );
      }
    } catch (error) {
      console.error("Error fetching agents:", error);
    }
  };

  const handleCreateRoom = async () => {
    if (!newRoomName.trim()) return;

    try {
      const response = await fetch(`/agents/${agentId}/rooms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: newRoomName,
          type: ChannelType.GROUP,
          entityId: "10000000-0000-0000-0000-000000000000",
        }),
      });

      const data = await response.json();

      if (data.success) {
        setIsCreateDialogOpen(false);
        setNewRoomName("");
        setNewRoomMembers([]);
        
        // Fetch updated rooms and navigate to the new room
        await fetchRooms();
        
        // Select the new room to navigate to it
        console.log(`Room created with ID: ${data.data.id}`);
        onSelectRoom(data.data.id as UUID);
        
        // Navigate to the room
        navigate(`/chat/${agentId}?roomId=${data.data.id}`);
      } else {
        toast({
          variant: "destructive",
          title: "Failed to create room",
          description: data.error.message || "Unknown error occurred",
        });
      }
    } catch (error) {
      console.error("Error creating room:", error);
      toast({
        variant: "destructive",
        title: "Error creating room",
        description: "Could not connect to server",
      });
    }
  };

  const handleUpdateRoom = async () => {
    if (!currentRoom || !currentRoom.name.trim()) return;

    try {
      const response = await fetch(
        `/agents/${agentId}/rooms/${currentRoom.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: currentRoom.name,
            type: currentRoom.type,
          }),
        }
      );

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Room updated",
          description: `${currentRoom.name} has been updated successfully`,
        });
        fetchRooms();
        setIsEditDialogOpen(false);
      } else {
        toast({
          variant: "destructive",
          title: "Failed to update room",
          description: data.error.message || "Unknown error occurred",
        });
      }
    } catch (error) {
      console.error("Error updating room:", error);
      toast({
        variant: "destructive",
        title: "Error updating room",
        description: "Could not connect to server",
      });
    }
  };

  const handleDeleteRoom = async (roomId: string) => {
    if (
      !confirm(
        "Are you sure you want to delete this room? This action cannot be undone."
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`/agents/${agentId}/rooms/${roomId}`, {
        method: "DELETE",
      });

      if (response.status === 204) {
        toast({
          title: "Room deleted",
          description: "The room has been deleted successfully",
        });
        fetchRooms();
        if (selectedRoomId === roomId) {
          // If the currently selected room was deleted, reset selection
          onSelectRoom(agentId as UUID); // Default to agent's DM room
        }
      } else {
        const data = await response.json();
        toast({
          variant: "destructive",
          title: "Failed to delete room",
          description: data.error.message || "Unknown error occurred",
        });
      }
    } catch (error) {
      console.error("Error deleting room:", error);
      toast({
        variant: "destructive",
        title: "Error deleting room",
        description: "Could not connect to server",
      });
    }
  };

  const handleAddParticipant = async (participantId: string) => {
    if (!currentRoom) return;

    try {
      const response = await fetch(
        `/agents/${agentId}/rooms/${currentRoom.id}/participants`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            participantId,
          }),
        }
      );

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Participant added",
          description: "The agent has been added to the room",
        });

        // Refresh room participants
        const roomResponse = await fetch(
          `/agents/${agentId}/rooms/${currentRoom.id}`
        );
        const roomData = await roomResponse.json();

        if (roomData.success) {
          setCurrentRoom({
            ...currentRoom,
            entities: roomData.data.entities,
          });
        }
      } else {
        toast({
          variant: "destructive",
          title: "Failed to add participant",
          description: data.error.message || "Unknown error occurred",
        });
      }
    } catch (error) {
      console.error("Error adding participant:", error);
      toast({
        variant: "destructive",
        title: "Error adding participant",
        description: "Could not connect to server",
      });
    }
  };

  const handleRemoveParticipant = async (participantId: string) => {
    if (!currentRoom) return;

    try {
      const response = await fetch(
        `/agents/${agentId}/rooms/${currentRoom.id}/participants/${participantId}?adminEntityId=10000000-0000-0000-0000-000000000000`,
        {
          method: "DELETE",
        }
      );

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Participant removed",
          description: "The agent has been removed from the room",
        });

        // Refresh room participants
        const roomResponse = await fetch(
          `/agents/${agentId}/rooms/${currentRoom.id}`
        );
        const roomData = await roomResponse.json();

        if (roomData.success) {
          setCurrentRoom({
            ...currentRoom,
            entities: roomData.data.entities,
          });
        }
      } else {
        toast({
          variant: "destructive",
          title: "Failed to remove participant",
          description: data.error.message || "Unknown error occurred",
        });
      }
    } catch (error) {
      console.error("Error removing participant:", error);
      toast({
        variant: "destructive",
        title: "Error removing participant",
        description: "Could not connect to server",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-medium">Rooms</h3>
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-medium">Rooms</h3>
        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="icon">
              <Plus className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Room</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="room-name">Room Name</Label>
                <Input
                  id="room-name"
                  placeholder="Enter room name"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsCreateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleCreateRoom}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-2">
        {rooms.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <p>No rooms available</p>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => setIsCreateDialogOpen(true)}
            >
              <PlusCircle className="h-4 w-4 mr-2" />
              Create a room
            </Button>
          </div>
        ) : (
          rooms.map((room) => (
            <div
              key={room.id}
              className={cn(
                "flex items-center justify-between p-2 rounded-md cursor-pointer group",
                selectedRoomId === room.id ? "bg-accent" : "hover:bg-accent/50"
              )}
              onClick={() => onSelectRoom(room.id as UUID)}
            >
              <div className="flex items-center gap-2">
                {room.type === ChannelType.GROUP ? (
                  <Hash className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <User className="h-4 w-4 text-muted-foreground" />
                )}
                <span>{room.name}</span>
              </div>
              {room.type === ChannelType.GROUP && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteRoom(room.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
