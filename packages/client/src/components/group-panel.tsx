import { randomUUID } from '../lib/utils';
import { Separator } from '@/components/ui/separator';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useRooms } from '@/hooks/use-query-hooks';
import { apiClient } from '@/lib/api';
import { type Agent, AgentStatus, type UUID } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, Trash, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import MultiSelectCombobox from './combobox';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';

// Define the Option type to match what MultiSelectCombobox expects
interface Option {
  icon: string;
  label: string;
  id?: string; // We'll add this to track agent IDs
}

interface GroupPanel {
  agents: Agent[] | undefined;
  onClose: () => void;
  groupId?: UUID;
}

export default function GroupPanel({ onClose, agents, groupId }: GroupPanel) {
  const [chatName, setChatName] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Agent[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [initialOptions, setInitialOptions] = useState<Option[]>([]);

  const { data: roomsData } = useRooms();

  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (groupId) {
      const rooms = roomsData?.get(groupId);
      if (!rooms || !rooms.length) {
        return;
      }
      setChatName(rooms[0].name || '');

      // Pre-select agents that are already in the room
      if (agents) {
        const roomAgentIds = rooms.map((room) => room.agentId).filter(Boolean);
        const roomAgents = agents.filter((agent) => roomAgentIds.includes(agent.id));

        setSelectedAgents(roomAgents);

        // Create initial options for the combobox
        const options = roomAgents.map((agent) => ({
          icon: agent.settings?.avatar || '',
          label: agent.name,
          id: agent.id,
        }));

        setInitialOptions(options);
      }
    }
  }, [groupId, roomsData, agents]);

  // Create the options for the combobox
  const getComboboxOptions = () => {
    return (
      agents
        ?.filter((agent) => agent.status === AgentStatus.ACTIVE)
        .map((agent) => ({
          icon: agent.settings?.avatar || '',
          label: agent.name,
          id: agent.id,
        })) || []
    );
  };
  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Card className="w-[80%] max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-xl font-semibold">
            {groupId ? 'Edit Group Chat' : 'Create Group Chat'}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <Separator />

        <CardContent className="pt-4">
          <div className="flex flex-col gap-4 w-full">
            <div className="flex flex-col gap-2 w-full">
              <label htmlFor="chat-name" className="text-sm font-medium">
                Chat Name
              </label>
              <Input
                id="chat-name"
                value={chatName}
                onChange={(e) => setChatName(e.target.value)}
                className="w-full"
                placeholder="Enter room name"
              />
            </div>

            <div className="flex flex-col gap-2 w-full">
              <label htmlFor="invite-agents" className="text-sm font-medium">
                Invite Agents
              </label>
              <MultiSelectCombobox
                options={getComboboxOptions()}
                onSelect={(selected) => {
                  if (agents) {
                    // Convert selected options back to Agent objects by matching on label (name)
                    const selectedAgentObjects = agents.filter((agent) =>
                      selected.some((option) => option.label === agent.name)
                    );
                    setSelectedAgents(selectedAgentObjects);
                  }
                }}
                className="w-full"
                initialSelected={initialOptions}
              />
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex justify-between pt-4">
          {groupId && (
            <Button
              variant="destructive"
              onClick={async () => {
                // Add confirmation dialog
                const confirmDelete = window.confirm(
                  `Are you sure you want to permanently delete the group chat "${chatName}"? This action cannot be undone.`
                );
                if (!confirmDelete) {
                  return;
                }
                setDeleting(true);
                try {
                  await apiClient.deleteGroupChat(groupId);
                } catch (error) {
                  console.error('Failed to delete room', error);
                } finally {
                  setDeleting(false);
                  navigate(`/`);
                  onClose();
                  queryClient.invalidateQueries({ queryKey: ['rooms'] });
                }
              }}
              disabled={deleting || creating}
            >
              {deleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash className="mr-2 h-4 w-4" />
              )}
              Delete Group
            </Button>
          )}

          <Button
            variant="default"
            className={groupId ? '' : 'w-full'}
            onClick={async () => {
              const serverId = groupId || randomUUID();
              if (!chatName || !chatName.length) {
                return;
              }
              setCreating(true);
              try {
                if (selectedAgents.length > 0) {
                  if (groupId) {
                    try {
                      await apiClient.deleteGroupChat(groupId);
                    } catch (error) {
                      console.error(error);
                    }
                  }
                  await apiClient.createGroupChat(
                    selectedAgents.map((agent) => agent.id as string),
                    chatName,
                    serverId,
                    GROUP_CHAT_SOURCE,
                    {}
                  );
                }
              } catch (error) {
                console.error('Failed to create group', error);
              } finally {
                setCreating(false);
                navigate(`/room/${serverId}`);
                onClose();
                queryClient.invalidateQueries({ queryKey: ['rooms'] });
              }
            }}
            disabled={!chatName.length || selectedAgents.length === 0 || deleting || creating}
          >
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {groupId ? 'Update Group' : 'Create Group'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
