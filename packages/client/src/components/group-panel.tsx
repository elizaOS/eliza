import { Separator } from '@/components/ui/separator';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useAgentsWithDetails, useChannels, useServers } from '@/hooks/use-query-hooks';
import { apiClient } from '@/lib/api';
import { type Agent, AgentStatus, type UUID } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import MultiSelectCombobox from './combobox';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { useToast } from '@/hooks/use-toast';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID; // Single default server

// Define the Option type to match what MultiSelectCombobox expects
interface Option {
  icon: string;
  label: string;
  id?: string; // We'll add this to track agent IDs
}

interface GroupPanel {
  agents: Partial<Agent>[] | undefined;
  onClose: () => void;
  channelId?: UUID;
}

/**
 * Displays a modal panel for creating or editing a group chat channel, allowing users to set a group name and select agents to include.
 *
 * If a {@link channelId} is provided, the panel loads the existing channel's details for editing; otherwise, it initializes for channel creation. Users can invite agents, update the channel name, create a new channel, update an existing channel, or delete a channel. Upon successful operations, the component navigates to the relevant channel, closes the panel, and refreshes the channel list.
 *
 * @param onClose - Callback invoked to close the panel.
 * @param agents - List of available agents to invite to the group chat.
 * @param channelId - Optional ID of the channel to edit.
 */
export default function GroupPanel({ onClose, agents, channelId }: GroupPanel) {
  const [chatName, setChatName] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Partial<Agent>[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [serverId, setServerId] = useState<UUID>(DEFAULT_SERVER_ID);

  const { data: channelsData, refetch: refetchChannels } = useChannels(serverId || undefined, { enabled: !!serverId && !!channelId });
  const { data: agentsData } = useAgentsWithDetails();

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (channelId && channelsData?.data?.channels) {
      const channel = channelsData.data.channels.find((ch) => ch.id === channelId);
      if (channel) {
        setChatName(channel.name || '');

        // Pre-select agents that are already in the channel - TODO: Requires channel participant data
        // if (channel.participants && agentsData?.agents) { // channel.participants does not exist on type
        //   const currentChannelParticipants = agentsData.agents.filter(agent => 
        //     (channel.participants as any[]).some(p => p === agent.id || p.id === agent.id)
        //   );
        //   setSelectedAgents(currentChannelParticipants);
        // } else {
        setSelectedAgents([]); // Default to empty for now
        // }
      }
    } else if (!channelId) {
      // Reset form for create mode
      setChatName('');
      setSelectedAgents([]);
    }
  }, [channelId, channelsData, agentsData]);

  // Create the options for the combobox from all available agents
  const getComboboxOptions = (): Option[] => {
    return (
      agentsData?.agents // Use agentsData (all agents) instead of props.agents
        ?.filter((agent) => agent.status === AgentStatus.ACTIVE && agent.name && agent.id)
        .map((agent) => ({
          icon: agent.settings?.avatar || '',
          label: agent.name || 'Unknown Agent',
          id: agent.id as string, // Ensure id is string for Option type
        })) || []
    );
  };

  // Get initial selected options for the combobox when editing
  const getInitialSelectedOptions = (): Option[] => {
    if (!channelId) return [];
    return selectedAgents.map(agent => ({
      icon: agent.settings?.avatar || '',
      label: agent.name || 'Unknown Agent',
      id: agent.id as string,
    }));
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Card className="w-[80%] max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-xl font-semibold">
            {channelId ? 'Edit Group Chat' : 'Create Group Chat'}
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
                placeholder="Enter chat name"
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
                    // Convert selected options back to Agent objects by matching on ID
                    const selectedAgentObjects = agents.filter((agent) =>
                      selected.some((option) => option.id === agent.id)
                    );
                    setSelectedAgents(selectedAgentObjects);
                  }
                }}
                className="w-full"
                initialSelected={getInitialSelectedOptions()}
              />
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex justify-between pt-4">
          {channelId && (
            <Button
              variant="destructive"
              onClick={async () => {
                const channel = channelsData?.data?.channels.find(ch => ch.id === channelId);
                const confirmDelete = window.confirm(
                  `Are you sure you want to permanently delete the group chat "${channel?.name || chatName || 'this group'}"? This action cannot be undone.`
                );
                if (!confirmDelete) {
                  return;
                }
                setDeleting(true);
                try {
                  // TODO: Implement apiClient.deleteCentralChannel(channelId);
                  // await apiClient.deleteCentralChannel(channelId); 
                  console.warn('apiClient.deleteCentralChannel is not implemented.');
                  toast({ title: 'Success (Simulated)', description: 'Group deletion simulated.' });
                  queryClient.invalidateQueries({ queryKey: ['channels', serverId] });
                  queryClient.invalidateQueries({ queryKey: ['channels'] });
                  navigate(`/`); // Navigate home after deletion
                  onClose();
                } catch (error) {
                  console.error('Failed to delete channel', error);
                  toast({ title: 'Error', description: 'Failed to delete group.', variant: 'destructive' });
                } finally {
                  setDeleting(false);
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
            className={channelId ? '' : 'w-full'}
            onClick={async () => {
              if (!chatName || !chatName.length || !serverId) {
                return;
              }
              setCreating(true);
              try {
                if (!channelId) {
                  // Create new channel
                  const participantIds = selectedAgents.map((agent) => agent.id as UUID);
                  const response = await apiClient.createCentralGroupChat({
                    name: chatName,
                    participantCentralUserIds: participantIds,
                    type: 'group',
                    server_id: serverId,
                    metadata: {
                      source: GROUP_CHAT_SOURCE,
                    },
                  });

                  if (response.data) {
                    toast({ title: 'Success', description: `Group "${chatName}" created.` });
                    navigate(`/group/${response.data.id}?serverId=${serverId}`);
                  }
                } else {
                  // Update existing channel
                  const participantIds = selectedAgents.map((agent) => agent.id as UUID);
                  // TODO: Implement apiClient.updateCentralGroupChat(channelId, { ... });
                  // await apiClient.updateCentralGroupChat(channelId, {
                  //   name: chatName,
                  //   participantCentralUserIds: participantIds,
                  // });
                  console.warn('apiClient.updateCentralGroupChat is not implemented.');
                  toast({ title: 'Success (Simulated)', description: `Group "${chatName}" update simulated.` });
                  navigate(`/group/${channelId}?serverId=${serverId}`);
                }
              } catch (error) {
                console.error('Failed to create/update group', error);
                const action = channelId ? 'update' : 'create';
                toast({ title: 'Error', description: `Failed to ${action} group.`, variant: 'destructive' });
              } finally {
                setCreating(false);
                onClose();
                queryClient.invalidateQueries({ queryKey: ['channels', serverId] });
                queryClient.invalidateQueries({ queryKey: ['channels'] });
              }
            }}
            disabled={!chatName.trim().length || !serverId || deleting || creating}
          >
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {channelId ? 'Update Group' : 'Create Group'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
