import { Separator } from '@/components/ui/separator';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useAgentsWithDetails, useChannels } from '@/hooks/use-query-hooks';
import { apiClient } from '@/lib/api';
import { type Agent, AgentStatus, type UUID, validateUuid } from '@elizaos/core';
import { useQueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Loader2, Trash, X } from 'lucide-react';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router';
import MultiSelectCombobox from './combobox';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { useToast } from '@/hooks/use-toast';
import clientLogger from '@/lib/logger';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

// This Option type must precisely match what MultiSelectCombobox.tsx expects for its props.
// Based on MultiSelectCombobox.tsx: { icon: string; label: string; id?: string; }
interface ComboboxOption {
  icon: string;
  label: string;
  id?: string; // We will always provide agent.id here, which is UUID (string)
}

interface GroupPanelProps {
  onClose: () => void;
  channelId?: UUID;
}

interface ChannelParticipantsResponse {
  success: boolean;
  data?: UUID[];
  error?: { message?: string; code?: number | string };
}

type SelectableAgent = Agent & { id: UUID; name: string };

function isAgentSelectable(agent: Partial<Agent>): agent is SelectableAgent {
  return !!agent.id && !!validateUuid(agent.id) && typeof agent.name === 'string' && agent.name.trim() !== '';
}

export default function GroupPanel({ onClose, channelId }: GroupPanelProps) {
  const [chatName, setChatName] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<SelectableAgent[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const serverId = DEFAULT_SERVER_ID;

  const { data: channelsData } = useChannels(channelId ? serverId : undefined, { enabled: !!channelId });
  const { data: agentsData, isLoading: isLoadingAgents, isError: isErrorAgents } = useAgentsWithDetails();

  const allAvailableSelectableAgents = useMemo(() => {
    return (agentsData?.agents || []).filter(isAgentSelectable);
  }, [agentsData]);

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();

  const {
    data: channelParticipantsApiResponse,
    isLoading: isLoadingChannelParticipants,
    isError: isErrorChannelParticipants,
    error: errorChannelParticipants
  }: UseQueryResult<ChannelParticipantsResponse, Error> = useQuery({
    queryKey: ['channelParticipants', channelId],
    queryFn: async () => {
      if (!channelId) return { success: true, data: [] };
      return apiClient.getChannelParticipants(channelId);
    },
    enabled: !!channelId,
  });

  useEffect(() => {
    if (isLoadingAgents) return;
    if (channelId && isLoadingChannelParticipants) return;

    if (channelId) {
      const channelDetails = channelsData?.data?.channels.find((ch) => ch.id === channelId);
      if (chatName !== (channelDetails?.name || '')) {
        setChatName(channelDetails?.name || '');
      }

      if (isErrorChannelParticipants) {
        toast({ title: "Error", description: `Could not load group participants: ${errorChannelParticipants?.message || 'Unknown error'}`, variant: "destructive" });
        if (selectedAgents.length > 0) setSelectedAgents([]);
        return;
      }
      if (channelParticipantsApiResponse?.success && channelParticipantsApiResponse.data) {
        const participantIds = channelParticipantsApiResponse.data;
        const newSelected = allAvailableSelectableAgents.filter(agent => participantIds.includes(agent.id));

        const currentSelectedIds = selectedAgents.map(a => a.id).sort().join(',');
        const newSelectedIds = newSelected.map(a => a.id).sort().join(',');

        if (currentSelectedIds !== newSelectedIds) {
          setSelectedAgents(newSelected);
        }
      } else if (channelParticipantsApiResponse && !channelParticipantsApiResponse.success) {
        toast({ title: "Error", description: `Could not load group participants: ${channelParticipantsApiResponse.error?.message || 'Server error'}`, variant: "destructive" });
        if (selectedAgents.length > 0) setSelectedAgents([]);
      } else {
        if (selectedAgents.length > 0) setSelectedAgents([]);
      }
    } else {
      if (chatName !== '') setChatName('');
      if (selectedAgents.length > 0) setSelectedAgents([]);
    }
  }, [
    channelId, isLoadingAgents, isLoadingChannelParticipants, channelsData,
    channelParticipantsApiResponse, allAvailableSelectableAgents, isErrorChannelParticipants,
    errorChannelParticipants, toast, chatName, selectedAgents
  ]);

  const comboboxOptions: ComboboxOption[] = useMemo(() => {
    if (isLoadingAgents || isErrorAgents) return [];
    return allAvailableSelectableAgents.map((agent) => ({
      id: agent.id,
      label: `${agent.name}${agent.status === AgentStatus.INACTIVE ? ' (Inactive)' : ''}`,
      icon: agent.settings?.avatar || '', // Ensure icon is always a string
    }));
  }, [allAvailableSelectableAgents, isLoadingAgents, isErrorAgents]);

  const STABLE_EMPTY_COMBOBOX_OPTIONS_ARRAY = useMemo(() => [], []);

  const initialSelectedComboboxOptions: ComboboxOption[] = useMemo(() => {
    if (isLoadingAgents) return STABLE_EMPTY_COMBOBOX_OPTIONS_ARRAY;
    if (!channelId) return STABLE_EMPTY_COMBOBOX_OPTIONS_ARRAY; // Create mode
    if (selectedAgents.length === 0) return STABLE_EMPTY_COMBOBOX_OPTIONS_ARRAY; // No agents selected

    return selectedAgents.map(agent => ({
      id: agent.id,
      label: `${agent.name}${agent.status === AgentStatus.INACTIVE ? ' (Inactive)' : ''}`,
      icon: agent.settings?.avatar || '',
    }));
  }, [channelId, selectedAgents, isLoadingAgents, STABLE_EMPTY_COMBOBOX_OPTIONS_ARRAY]);

  const handleSelectAgents = useCallback((selectedOptions: ComboboxOption[]) => {
    const newSelectedAgentObjects = allAvailableSelectableAgents.filter(agent =>
      selectedOptions.some(option => option.id === agent.id)
    );
    setSelectedAgents(newSelectedAgentObjects);
  }, [allAvailableSelectableAgents]);

  const handleDeleteGroup = useCallback(async () => {
    if (!channelId) return;
    const channel = channelsData?.data?.channels.find(ch => ch.id === channelId);
    const confirmDelete = window.confirm(
      `Are you sure you want to permanently delete the group chat "${channel?.name || chatName || 'this group'}"? This action cannot be undone.`
    );
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiClient.deleteChannel(channelId);
      toast({ title: 'Group Deleted', description: 'The group has been successfully deleted.' });
      queryClient.invalidateQueries({ queryKey: ['channels', serverId] });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      navigate(`/`);
      onClose();
    } catch (error) {
      clientLogger.error('Failed to delete channel', error);
      const errorMsg = error instanceof Error ? error.message : 'Could not delete group.';
      if (typeof error === 'object' && error !== null && (error as any).statusCode === 404) {
        toast({ title: 'Error Deleting Group', description: "Delete operation not found on server.", variant: 'destructive' });
      } else {
        toast({ title: 'Error Deleting Group', description: errorMsg, variant: 'destructive' });
      }
    } finally {
      setDeleting(false);
    }
  }, [channelId, chatName, channelsData, navigate, onClose, queryClient, serverId, toast]);

  const handleCreateOrUpdateGroup = useCallback(async () => {
    if (!channelId && selectedAgents.length === 0) {
      toast({ title: "Validation Error", description: "Please select at least one agent for the group.", variant: "destructive" });
      return;
    }
    setCreating(true);
    const participantIds = selectedAgents.map(agent => agent.id);
    try {
      if (!channelId) {
        const response = await apiClient.createCentralGroupChat({
          name: '',
          participantCentralUserIds: participantIds,
          type: 'group',
          server_id: serverId,
          metadata: { source: GROUP_CHAT_SOURCE },
        });
        if (response.data) {
          toast({ title: 'Success', description: 'Group created successfully.' });
          navigate(`/group/${response.data.id}?serverId=${serverId}`);
          onClose();
        }
      } else {
        await apiClient.updateChannel(channelId, {
          name: chatName,
          participantCentralUserIds: participantIds,
        });
        toast({ title: 'Group Updated', description: 'Group details updated successfully.' });
        navigate(`/group/${channelId}?serverId=${serverId}`);
        onClose();
      }
    } catch (error) {
      clientLogger.error('Failed to create/update group', error);
      const action = channelId ? 'update' : 'create';
      const errorMsg = error instanceof Error ? error.message : `Failed to ${action} group.`;
      toast({ title: 'Error', description: errorMsg, variant: 'destructive' });
    } finally {
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ['channels', serverId] });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    }
  }, [channelId, chatName, selectedAgents, serverId, navigate, onClose, queryClient, toast]);

  const isSubmitDisabled =
    (!channelId && selectedAgents.length === 0) ||
    creating ||
    deleting ||
    (isErrorAgents && allAvailableSelectableAgents.length === 0) ||
    (!!channelId && isLoadingChannelParticipants);

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Card className="w-[80%] max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
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
            {channelId && (
              <div className="flex flex-col gap-2 w-full">
                <label htmlFor="chat-name" className="text-sm font-medium">
                  Chat Name (Optional)
                </label>
                <Input
                  id="chat-name"
                  value={chatName}
                  onChange={(e) => setChatName(e.target.value)}
                  className="w-full bg-background text-foreground"
                  placeholder="Leave blank to auto-generate from participants"
                  disabled={creating || deleting}
                />
              </div>
            )}

            <div className="flex flex-col gap-2 w-full">
              <label htmlFor="invite-agents" className="text-sm font-medium">
                Select Agents {!channelId && <span className="text-muted-foreground">(Required)</span>}
              </label>
              {isLoadingAgents ? (
                <div className="flex items-center justify-center p-4">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-muted-foreground">Loading agents...</span>
                </div>
              ) : isErrorAgents ? (
                <div className="flex items-center justify-center p-4 text-red-500">
                  Error loading agents. Please try again later.
                </div>
              ) : (
                <MultiSelectCombobox
                  options={comboboxOptions}
                  onSelect={handleSelectAgents}
                  className="w-full"
                  initialSelected={initialSelectedComboboxOptions}
                  key={`group-panel-combobox-${channelId || 'create'}-${allAvailableSelectableAgents.length}`}
                />
              )}
              {selectedAgents.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {selectedAgents.length} agent{selectedAgents.length > 1 ? 's' : ''} selected
                </p>
              )}
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex justify-between pt-4">
          {channelId && (
            <Button
              variant="destructive"
              onClick={handleDeleteGroup}
              disabled={deleting || creating || isLoadingAgents}
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
            onClick={handleCreateOrUpdateGroup}
            disabled={isSubmitDisabled}
          >
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {channelId ? 'Update Group' : 'Create Group'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

