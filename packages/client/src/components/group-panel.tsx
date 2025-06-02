import { Separator } from '@/components/ui/separator';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useServers, useChannels } from '@/hooks/use-query-hooks';
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
  const [initialOptions, setInitialOptions] = useState<Option[]>([]);
  const [serverId, setServerId] = useState<UUID | null>(null);

  const { data: channelsData } = useChannels(serverId || undefined);

  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    // Always use the default server (ID "0")
    setServerId(DEFAULT_SERVER_ID);
  }, []);

  useEffect(() => {
    if (channelId && channelsData?.data?.channels) {
      const channel = channelsData.data.channels.find(ch => ch.id === channelId);
      if (channel) {
        setChatName(channel.name || '');

        // TODO: Pre-select agents that are already in the channel
        // This would require getting channel participants from the server
        // For now, start with empty selection
        setSelectedAgents([]);
        setInitialOptions([]);
      }
    }
  }, [channelId, channelsData]);

  // Create the options for the combobox
  const getComboboxOptions = () => {
    return (
      agents
        ?.filter((agent) => agent.status === AgentStatus.ACTIVE && agent.name && agent.id)
        .map((agent) => ({
          icon: agent.settings?.avatar || '',
          label: agent.name || 'Unknown Agent',
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
                initialSelected={initialOptions}
              />
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex justify-between pt-4">
          {channelId && (
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
                  await apiClient.deleteChannelMessage(channelId, channelId);
                  // TODO: Add proper channel deletion endpoint
                } catch (error) {
                  console.error('Failed to delete channel', error);
                } finally {
                  setDeleting(false);
                  navigate(`/`);
                  onClose();
                  queryClient.invalidateQueries({ queryKey: ['channels'] });
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
                  const participantIds = selectedAgents.map(agent => agent.id as UUID);
                  const response = await apiClient.createCentralGroupChat({
                    name: chatName,
                    participantCentralUserIds: participantIds,
                    type: 'group',
                    server_id: serverId,
                    metadata: {
                      source: GROUP_CHAT_SOURCE
                    }
                  });

                  if (response.data) {
                    navigate(`/group/${response.data.id}`);
                  }
                } else {
                  // TODO: Update existing channel
                  // This would require an update channel endpoint
                  console.log('Channel update not yet implemented');
                }
              } catch (error) {
                console.error('Failed to create/update group', error);
              } finally {
                setCreating(false);
                onClose();
                queryClient.invalidateQueries({ queryKey: ['channels'] });
              }
            }}
            disabled={!chatName.length || !serverId || deleting || creating}
          >
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {channelId ? 'Update Group' : 'Create Group'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
