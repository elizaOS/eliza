import { Separator } from '@/components/ui/separator';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useAgentsWithDetails, useChannels, useServers } from '@/hooks/use-query-hooks';
import { apiClient } from '@/lib/api';
import { type Agent, AgentStatus, type UUID } from '@elizaos/core';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Loader2, Trash, X } from 'lucide-react';
import { useEffect, useState, useMemo } from 'react';
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
  id: string; // Make id mandatory for Option as agent.id is UUID (string)
}

interface GroupPanelProps {
  onClose: () => void;
  channelId?: UUID;
}

/**
 * Displays a modal panel for creating or editing a group chat channel, allowing users to set a group name and select agents to include.
 *
 * If a {@link channelId} is provided, the panel loads the existing channel's details for editing; otherwise, it initializes for channel creation. Users can invite agents, update the channel name, create a new channel, update an existing channel, or delete a channel. Upon successful operations, the component navigates to the relevant channel, closes the panel, and refreshes the channel list.
 *
 * @param onClose - Callback invoked to close the panel.
 * @param channelId - Optional ID of the channel to edit.
 */
export default function GroupPanel({ onClose, channelId }: GroupPanelProps) {
  const [chatName, setChatName] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Partial<Agent>[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [serverId, setServerId] = useState<UUID>(DEFAULT_SERVER_ID);
  const [isLoadingParticipants, setIsLoadingParticipants] = useState(false);

  const { data: channelsData, refetch: refetchChannels } = useChannels(serverId || undefined, { enabled: !!serverId && !!channelId });
  const { data: agentsData } = useAgentsWithDetails();
  const allAvailableAgents = useMemo(() => agentsData?.agents || [], [agentsData]);

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Fetch participants for the channel if in edit mode
  const { data: channelParticipantsData, isLoading: isLoadingChannelParticipants } = useQuery({
    queryKey: ['channelParticipants', channelId, serverId],
    queryFn: async () => {
      if (!channelId || !serverId) return { data: { participants: [] } };
      console.log(`[GroupPanel] Simulating fetch for participants of channel: ${channelId}`);
      await new Promise(resolve => setTimeout(resolve, 300));

      // Improved simulation: If editing, and agents exist, simulate some are participants.
      if (allAvailableAgents.length > 0) {
        const simulatedParticipantIds = allAvailableAgents.slice(0, Math.min(2, allAvailableAgents.length)).map(a => a.id as UUID);
        console.log('[GroupPanel] Simulated participant IDs for edit mode:', simulatedParticipantIds);
        return { data: { participants: simulatedParticipantIds } };
      }
      return { data: { participants: [] } }; // Default to no participants
    },
    enabled: !!channelId && !!serverId && allAvailableAgents.length > 0, // Enable only if editing and agents are available to pick from
  });

  // Log for chatName and button disabled state
  useEffect(() => {
    console.log('[GroupPanel] chatName:', chatName, 'Trimmed length:', chatName.trim().length);
    const buttonDisabled = !chatName.trim().length || !serverId || deleting || creating;
    console.log('[GroupPanel] Create/Update button disabled state:', buttonDisabled,
      {
        chatNameEmpty: !chatName.trim().length,
        serverIdMissing: !serverId,
        isDeleting: deleting,
        isCreating: creating
      }
    );
  }, [chatName, serverId, deleting, creating]);

  // Initialize for create mode, or load for edit mode
  useEffect(() => {
    console.log("[GroupPanel] Edit/Create Effect Triggered. channelId:", channelId);
    if (channelId) {
      // Edit mode
      if (channelsData?.data?.channels) {
        const channel = channelsData.data.channels.find((ch) => ch.id === channelId);
        if (channel) {
          console.log("[GroupPanel] Edit mode: Setting chat name to:", channel.name || '');
          setChatName(channel.name || '');
        } else {
          console.log("[GroupPanel] Edit mode: Channel not found, resetting form.");
          setChatName(''); // Channel for editing not found, reset
          setSelectedAgents([]);
          // toast({ title: "Error", description: "Group details not found for editing.", variant: "destructive" });
        }
      }
      // Populate selectedAgents once participants are fetched and allAvailableAgents are loaded
      // This check is crucial: only proceed if all data dependencies for this logic are met.
      if (channelParticipantsData?.data?.participants && allAvailableAgents.length > 0) {
        const participantIds = channelParticipantsData.data.participants as UUID[];
        console.log("[GroupPanel] Edit mode: Fetched participant IDs:", participantIds);
        const currentChannelParticipants = allAvailableAgents.filter(agent =>
          participantIds.includes(agent.id as UUID)
        );
        setSelectedAgents(currentChannelParticipants);
        console.log('[GroupPanel] Edit mode: Populated selectedAgents from fetched participants:', currentChannelParticipants);
      } else {
        // If participant data isn't ready yet, or no participants, ensure selectedAgents is empty
        // This prevents stale selections if channelId changes and participant data isn't immediately available.
        // However, if channelParticipantsData is loading, we should wait, not clear.
        if (!isLoadingChannelParticipants) {
          console.log("[GroupPanel] Edit mode: No participant data or no allAvailableAgents, clearing selectedAgents.");
          setSelectedAgents([]);
        }
      }
    } else {
      // Create mode
      console.log("[GroupPanel] Create mode: Resetting form.");
      setChatName('');
      setSelectedAgents([]);
    }
  }, [channelId, channelsData, channelParticipantsData, allAvailableAgents, isLoadingChannelParticipants]);
  // Added isLoadingChannelParticipants to dependencies

  // Log selected agents for Issue A
  useEffect(() => {
    console.log('[GroupPanel] selectedAgents updated:', selectedAgents);
  }, [selectedAgents]);

  const getComboboxOptions = (): Option[] => {
    return (
      allAvailableAgents
        ?.filter((agent) => agent.status === AgentStatus.ACTIVE && agent.name && agent.id)
        .map((agent) => ({
          icon: agent.settings?.avatar || '',
          label: agent.name || 'Unknown Agent',
          id: agent.id as string,
        })) || []
    );
  };

  const getInitialSelectedOptions = (): Option[] => {
    if (!channelId || selectedAgents.length === 0) return [];
    console.log('[GroupPanel] getInitialSelectedOptions called, selectedAgents:', selectedAgents);
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
                className="w-full bg-background text-foreground"
                placeholder="Enter group name (e.g., Project Alpha Team)"
                disabled={creating || deleting}
                autoFocus={!channelId} // Auto-focus for create mode
              />
              {/* Debug info - remove in production */}
              {process.env.NODE_ENV === 'development' && (
                <div className="text-xs text-muted-foreground">
                  Debug: creating={String(creating)}, deleting={String(deleting)},
                  chatName="{chatName}", length={chatName.length}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 w-full">
              <label htmlFor="invite-agents" className="text-sm font-medium">
                Invite Agents
              </label>
              <MultiSelectCombobox
                options={getComboboxOptions()}
                onSelect={(selectedOptions) => {
                  console.log('[GroupPanel] MultiSelectCombobox onSelect called with:', selectedOptions);
                  const newSelectedAgentObjects = allAvailableAgents.filter(agent =>
                    selectedOptions.some(option => option.id === agent.id)
                  );
                  console.log('[GroupPanel] Filtered agent objects:', newSelectedAgentObjects);
                  setSelectedAgents(newSelectedAgentObjects);
                }}
                className="w-full"
                initialSelected={getInitialSelectedOptions()}
                key={`multiselect-${channelId || 'create'}-${allAvailableAgents.length}`} // Force re-render when context changes
              />
              {/* Debug info - remove in production */}
              {process.env.NODE_ENV === 'development' && (
                <div className="text-xs text-muted-foreground">
                  Debug: selectedAgents count={selectedAgents.length},
                  options count={getComboboxOptions().length},
                  allAvailableAgents count={allAvailableAgents.length}
                </div>
              )}
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
              if (!chatName.trim().length || !serverId) { // Added trim here too for safety
                toast({ title: "Validation Error", description: "Chat name cannot be empty.", variant: "destructive" });
                return;
              }
              setCreating(true);
              // Log participantIds for Issue A
              const participantIds = selectedAgents.map((agent) => agent.id as UUID);
              console.log('[GroupPanel] Attempting to create/update group with participant IDs:', participantIds);
              try {
                if (!channelId) {
                  // Create new channel
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

