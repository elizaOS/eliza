import { useState, useEffect } from 'react';
import { ChannelType, type UUID, type Agent } from '@elizaos/core';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAgents } from '@/hooks/use-query-hooks';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Room } from '@/types/rooms';
import axios from 'axios';

interface RoomListProps {
  agentId: UUID;
  onSelectRoom: (roomId: UUID) => void;
  selectedRoomId: UUID | null;
}

export function RoomList({ agentId, onSelectRoom, selectedRoomId }: RoomListProps) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState<boolean>(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState<boolean>(false);
  const [isParticipantsDialogOpen, setIsParticipantsDialogOpen] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState<boolean>(false);
  const [createRoomError, setCreateRoomError] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState<string>('');
  const [newRoomMembers, setNewRoomMembers] = useState<string[]>([]);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string }[]>([]);
  const { data: agentsData } = useAgents();
  const { toast } = useToast();
  const navigate = useNavigate();

  const fetchRooms = async () => {
    setIsLoading(true);
    try {
      console.log(`[RoomList] Fetching rooms for agent ${agentId}`);
      const response = await fetch(`/agents/${agentId}/rooms?includeDefaultRooms=true`);
      const data = await response.json();

      if (data.success) {
        console.log(`[RoomList] Found ${data.data.length} rooms`);
        setRooms(data.data);
      } else {
        console.error(`[RoomList] Error fetching rooms:`, data.error);
        toast({
          variant: 'destructive',
          title: 'Error loading rooms',
          description: data.error.message || 'Unknown error occurred',
        });
      }
    } catch (error) {
      console.error(`[RoomList] Error fetching rooms:`, error);
      toast({
        variant: 'destructive',
        title: 'Error loading rooms',
        description: 'Could not connect to server',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAvailableAgents = async () => {
    try {
      console.log(`[RoomList] Fetching available agents`);
      const response = await fetch(`/agents`);
      const data = await response.json();

      if (data.success) {
        console.log(`[RoomList] Found ${data.data.agents.length} available agents`);
        // Filter out the current agent
        const filteredAgents = data.data.agents
          .filter((agent: any) => agent.id !== agentId)
          .map((agent: any) => ({
            id: agent.id,
            name: agent.name,
          }));

        setAvailableAgents(filteredAgents);
      } else {
        console.error(`[RoomList] Error fetching agents:`, data.error);
      }
    } catch (error) {
      console.error(`[RoomList] Error fetching agents:`, error);
    }
  };

  useEffect(() => {
    fetchRooms();
    fetchAvailableAgents();
  }, [agentId]);

  const handleSelectRoom = (roomId: UUID) => {
    onSelectRoom(roomId);

    // Navigate to the chat with the explicit roomId parameter
    console.log(`[RoomList] Navigating to room ${roomId}`);
    navigate(`/chat/${agentId}?roomId=${roomId}`);
  };

  const createConceptualRoom = async (
    agentId: string,
    roomName: string,
    roomType: string = 'GROUP'
  ): Promise<string | null> => {
    try {
      const response = await axios.post(
        `${import.meta.env.VITE_API_URL || ''}/api/room-mappings/conceptual-room`,
        {
          name: roomName,
          type: roomType,
          agentId,
        }
      );

      if (response.data.success) {
        return response.data.data.conceptualRoomId;
      }

      console.error('Failed to create conceptual room:', response.data.error);
      return null;
    } catch (error) {
      console.error('Error creating conceptual room:', error);
      return null;
    }
  };

  const handleCreateRoom = async () => {
    setIsCreatingRoom(true);
    setCreateRoomError(null);

    try {
      if (!newRoomName) {
        setCreateRoomError('Please enter a room name');
        return;
      }

      if (!availableAgents.length) {
        setCreateRoomError('Please select at least one agent');
        return;
      }

      const agentsToAdd = availableAgents.map((a) => a.id);

      // Create a conceptual room
      const conceptualRoomId = await createConceptualRoom(agentId.toString(), newRoomName);

      if (!conceptualRoomId) {
        setCreateRoomError('Failed to create room');
        return;
      }

      // Add selected agents to the room
      for (const agentId of agentsToAdd) {
        try {
          await axios.post(`${import.meta.env.VITE_API_URL || ''}/api/room-mappings/add-agent`, {
            conceptualRoomId,
            agentId,
          });
        } catch (error) {
          console.error(`Failed to add agent ${agentId} to room:`, error);
          // Continue with other agents even if one fails
        }
      }

      // Navigate to the new room - use the conceptual room URL format
      navigate(`/chat/${agentId}/${conceptualRoomId}`);

      // Reset UI state
      setNewRoomName('');
      setIsCreateDialogOpen(false);
    } catch (error) {
      console.error('Error creating room:', error);
      setCreateRoomError('Failed to create room');
    } finally {
      setIsCreatingRoom(false);
    }
  };

  const handleUpdateRoom = async () => {
    if (!currentRoom || !currentRoom.name.trim()) return;

    try {
      const response = await fetch(`/agents/${agentId}/rooms/${currentRoom.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: currentRoom.name,
          type: currentRoom.type,
        }),
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: 'Room updated',
          description: `${currentRoom.name} has been updated successfully`,
        });
        fetchRooms();
        setIsEditDialogOpen(false);
      } else {
        toast({
          variant: 'destructive',
          title: 'Failed to update room',
          description: data.error.message || 'Unknown error occurred',
        });
      }
    } catch (error) {
      console.error('Error updating room:', error);
      toast({
        variant: 'destructive',
        title: 'Error updating room',
        description: 'Could not connect to server',
      });
    }
  };

  const handleDeleteRoom = async (roomId: string) => {
    if (!confirm('Are you sure you want to delete this room? This action cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(`/agents/${agentId}/rooms/${roomId}`, {
        method: 'DELETE',
      });

      if (response.status === 204) {
        toast({
          title: 'Room deleted',
          description: 'The room has been deleted successfully',
        });
        fetchRooms();
        if (selectedRoomId === roomId) {
          // If the currently selected room was deleted, reset selection
          onSelectRoom(agentId as UUID); // Default to agent's DM room
        }
      } else {
        const data = await response.json();
        toast({
          variant: 'destructive',
          title: 'Failed to delete room',
          description: data.error.message || 'Unknown error occurred',
        });
      }
    } catch (error) {
      console.error('Error deleting room:', error);
      toast({
        variant: 'destructive',
        title: 'Error deleting room',
        description: 'Could not connect to server',
      });
    }
  };

  const handleAddParticipant = async (participantId: string) => {
    if (!currentRoom) return;

    try {
      const response = await fetch(`/agents/${agentId}/rooms/${currentRoom.id}/participants`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          participantId,
        }),
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: 'Participant added',
          description: 'The agent has been added to the room',
        });

        // Refresh room participants
        const roomResponse = await fetch(`/agents/${agentId}/rooms/${currentRoom.id}`);
        const roomData = await roomResponse.json();

        if (roomData.success) {
          setCurrentRoom({
            ...currentRoom,
            entities: roomData.data.entities,
          });
        }
      } else {
        toast({
          variant: 'destructive',
          title: 'Failed to add participant',
          description: data.error.message || 'Unknown error occurred',
        });
      }
    } catch (error) {
      console.error('Error adding participant:', error);
      toast({
        variant: 'destructive',
        title: 'Error adding participant',
        description: 'Could not connect to server',
      });
    }
  };

  const handleRemoveParticipant = async (participantId: string) => {
    if (!currentRoom) return;

    try {
      const response = await fetch(
        `/agents/${agentId}/rooms/${currentRoom.id}/participants/${participantId}?adminEntityId=10000000-0000-0000-0000-000000000000`,
        {
          method: 'DELETE',
        }
      );

      const data = await response.json();

      if (data.success) {
        toast({
          title: 'Participant removed',
          description: 'The agent has been removed from the room',
        });

        // Refresh room participants
        const roomResponse = await fetch(`/agents/${agentId}/rooms/${currentRoom.id}`);
        const roomData = await roomResponse.json();

        if (roomData.success) {
          setCurrentRoom({
            ...currentRoom,
            entities: roomData.data.entities,
          });
        }
      } else {
        toast({
          variant: 'destructive',
          title: 'Failed to remove participant',
          description: data.error.message || 'Unknown error occurred',
        });
      }
    } catch (error) {
      console.error('Error removing participant:', error);
      toast({
        variant: 'destructive',
        title: 'Error removing participant',
        description: 'Could not connect to server',
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
    <div className="h-full flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Rooms</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setNewRoomName('');
            setIsCreateDialogOpen(true);
          }}
        >
          New Room
        </Button>
      </div>

      {/* Room List */}
      <div className="flex-1 overflow-auto py-2">
        {isLoading ? (
          <div className="flex justify-center items-center h-full">
            <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-gray-900"></div>
          </div>
        ) : rooms.length === 0 ? (
          <div className="flex flex-col justify-center items-center h-full text-center p-4">
            <p className="text-sm text-muted-foreground mb-2">No rooms found</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNewRoomName('');
                setIsCreateDialogOpen(true);
              }}
            >
              Create a Room
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Direct Message Rooms Section */}
            <div className="space-y-1">
              <div className="flex items-center px-2 py-1.5">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Direct Messages
                </span>
              </div>

              {rooms
                .filter((room) => room.type === ChannelType.DM)
                .map((room) => {
                  // Get the other entity in the DM (not the current agent)
                  const otherEntity = room.entities?.find(
                    (entity: { id: string; agentId?: string }) => entity.id !== agentId
                  );
                  const agentEntity = availableAgents.find(
                    (a) => otherEntity && a.id === otherEntity.id
                  );
                  const displayName = agentEntity?.name || room.name || 'Direct Message';

                  return (
                    <div
                      key={room.id}
                      className={cn(
                        'flex items-center gap-2 cursor-pointer p-2 rounded-md hover:bg-accent hover:text-accent-foreground',
                        selectedRoomId === room.id && 'bg-accent text-accent-foreground'
                      )}
                      onClick={() => handleSelectRoom(room.id as UUID)}
                    >
                      <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                        <i className="i-lucide-message-circle size-4" />
                      </div>
                      <div className="flex-1 truncate font-medium text-sm">{displayName}</div>
                    </div>
                  );
                })}
            </div>

            {/* Group Rooms Section */}
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Group Rooms
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 rounded-full"
                  onClick={() => {
                    setNewRoomName('');
                    setIsCreateDialogOpen(true);
                  }}
                >
                  <i className="i-lucide-plus size-3" />
                </Button>
              </div>

              {rooms
                .filter((room) => room.type === ChannelType.GROUP)
                .map((room) => {
                  // Get count of participants in the room
                  const participantCount = room.entities?.length || 0;
                  // Check which agents are in this room
                  const agentsInRoom =
                    room.entities?.filter((entity: { id: string; agentId?: string }) =>
                      // An entity is an agent if it matches an available agent ID
                      availableAgents.some((agent) => agent.id === entity.id)
                    ) || [];

                  return (
                    <div
                      key={room.id}
                      className={cn(
                        'flex flex-col cursor-pointer px-2 py-1.5 rounded-md hover:bg-accent hover:text-accent-foreground',
                        selectedRoomId === room.id && 'bg-accent text-accent-foreground'
                      )}
                      onClick={() => handleSelectRoom(room.id as UUID)}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className="size-8 rounded-md bg-primary/10 flex items-center justify-center text-primary">
                            <i className="i-lucide-users size-4" />
                          </div>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{room.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {participantCount}{' '}
                              {participantCount === 1 ? 'participant' : 'participants'}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 opacity-0 group-hover:opacity-100 hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCurrentRoom(room);
                              setIsEditDialogOpen(true);
                            }}
                          >
                            <i className="i-lucide-pencil size-3" />
                            <span className="sr-only">Edit</span>
                          </Button>
                        </div>
                      </div>

                      {/* Show agents in this room */}
                      {agentsInRoom.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1 ml-10">
                          {agentsInRoom.map((agent: { id: string; agentId?: string }) => {
                            const agentInfo = availableAgents.find((a) => a.id === agent.id);
                            return (
                              <Badge key={agent.id} variant="outline" className="text-xs">
                                {agentInfo?.name || 'Agent'}
                              </Badge>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>

      {/* Create Room Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Room</DialogTitle>
            <DialogDescription>
              Create a new chat room where you can invite multiple agents and participate in group
              conversations.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateRoom();
            }}
          >
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Room Name</Label>
                <Input
                  id="name"
                  placeholder="Enter room name"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Create Room</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Room Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Room</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleUpdateRoom();
            }}
          >
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Room Name</Label>
                <Input
                  id="name"
                  placeholder="Enter room name"
                  value={currentRoom?.name || ''}
                  onChange={(e) => {
                    if (currentRoom) {
                      setCurrentRoom({
                        ...currentRoom,
                        name: e.target.value,
                        id: currentRoom.id, // Ensure id is always present
                      } as Room);
                    }
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Update Room</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
