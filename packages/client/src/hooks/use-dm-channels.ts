import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import type { UUID, ChannelType } from '@elizaos/core';
import type { MessageChannel } from '@/types';
import clientLogger from '@/lib/logger';
import { STALE_TIMES } from './use-query-hooks';
import { getEntityId } from '@/lib/utils';

/**
 * Hook to get or create a DM channel between current user and target user (agent)
 */
export function useGetOrCreateDmChannel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const currentUserId = getEntityId();

  return useMutation({
    mutationFn: async (targetUserId: UUID) => {
      clientLogger.info('[useGetOrCreateDmChannel] Creating DM channel with target:', targetUserId);
      const response = await apiClient.getOrCreateDmChannel(targetUserId, currentUserId);
      return response.data;
    },
    onSuccess: (data) => {
      clientLogger.info('[useGetOrCreateDmChannel] DM channel created/found:', data);
      // Invalidate channel queries to refresh the list
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      queryClient.invalidateQueries({ queryKey: ['dmChannels'] });
    },
    onError: (error) => {
      clientLogger.error('[useGetOrCreateDmChannel] Error creating DM channel:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create DM channel',
        variant: 'destructive',
      });
    },
  });
}

/**
 * Hook to fetch all DM channels for a specific agent
 */
export function useDmChannelsForAgent(
  agentId: UUID | undefined,
  serverId: UUID = '00000000-0000-0000-0000-000000000000' as UUID
) {
  const currentUserId = getEntityId();

  return useQuery<MessageChannel[]>({
    queryKey: ['dmChannels', agentId, currentUserId],
    queryFn: async () => {
      if (!agentId) return [];

      clientLogger.info('[useDmChannelsForAgent] Fetching DM channels for agent:', agentId);

      // Get all channels for the server
      const response = await apiClient.getChannelsForServer(serverId);
      const allChannels = response.data?.channels || [];

      // Filter for DM channels that include both the current user and the agent
      const dmChannels = allChannels.filter((channel) => {
        // Check if it's a DM channel
        if (channel.type !== ('DM' as ChannelType)) return false;

        // Check if the channel name includes both user IDs (DM channel naming convention)
        const channelName = channel.name.toLowerCase();
        const hasCurrentUser = channelName.includes(currentUserId.toLowerCase());
        const hasAgent = channelName.includes(agentId.toLowerCase());

        // Also check metadata for participants
        const metadata = channel.metadata || {};
        const metadataHasUsers =
          (metadata.user1 === currentUserId || metadata.user2 === currentUserId) &&
          (metadata.user1 === agentId || metadata.user2 === agentId);

        return (hasCurrentUser && hasAgent) || metadataHasUsers;
      });

      clientLogger.info('[useDmChannelsForAgent] Found DM channels:', dmChannels.length);

      // Sort by last activity (most recent first)
      return dmChannels.sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt).getTime();
        return bTime - aTime;
      });
    },
    enabled: !!agentId,
    staleTime: STALE_TIMES.STANDARD,
    refetchInterval: false, // Only refetch on demand
  });
}

/**
 * Hook to create a new DM channel with meaningful name
 */
export function useCreateDmChannel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const currentUserId = getEntityId();

  return useMutation({
    mutationFn: async ({ agentId, channelName }: { agentId: UUID; channelName?: string }) => {
      clientLogger.info('[useCreateDmChannel] Creating new DM channel:', { agentId, channelName });

      // First get or create the DM channel with the agent
      const response = await apiClient.getOrCreateDmChannel(agentId, currentUserId);
      const channel = response.data;

      // If a custom name was provided, we could update the channel name here
      // (would need an updateChannel API endpoint)

      return channel;
    },
    onSuccess: (data, variables) => {
      clientLogger.info('[useCreateDmChannel] DM channel created:', data);

      toast({
        title: 'New Chat Created',
        description: `Started new conversation${variables.channelName ? `: ${variables.channelName}` : ''}`,
      });

      // Invalidate queries to refresh the channel lists
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      queryClient.invalidateQueries({ queryKey: ['dmChannels', variables.agentId] });
    },
    onError: (error) => {
      clientLogger.error('[useCreateDmChannel] Error creating DM channel:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create new chat',
        variant: 'destructive',
      });
    },
  });
}
