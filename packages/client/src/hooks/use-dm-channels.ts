import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import { useToast } from '@/hooks/use-toast';

// Create ElizaClient instance
const elizaClient = createElizaClient();
import { type UUID, ChannelType } from '@elizaos/core';
import type { MessageChannel } from '@/types';
import clientLogger from '@/lib/logger';
import { STALE_TIMES } from './use-query-hooks';
import { getEntityId } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';

/**
 * Hook to get or create a DM channel between current user and target user (agent)
 * This is the original behavior, usually resulting in a single canonical DM channel.
 */
export function useGetOrCreateDmChannel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const currentUserId = getEntityId();

  return useMutation({
    mutationFn: async (targetUserId: UUID) => {
      clientLogger.info(
        '[useGetOrCreateDmChannel] Getting or creating canonical DM channel with target:',
        targetUserId
      );
      const elizaClient = createElizaClient();
      const result = await elizaClient.messaging.getOrCreateDmChannel({
        participantIds: [currentUserId, targetUserId],
      });
      return result;
    },
    onSuccess: (data) => {
      clientLogger.info('[useGetOrCreateDmChannel] Canonical DM channel created/found:', data);
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      queryClient.invalidateQueries({ queryKey: ['dmChannels'] });
      const agentId =
        data.metadata?.user1 === currentUserId ? data.metadata?.user2 : data.metadata?.user1;
      if (agentId) {
        queryClient.invalidateQueries({ queryKey: ['dmChannels', agentId, currentUserId] });
      }
    },
    onError: (error) => {
      clientLogger.error(
        '[useGetOrCreateDmChannel] Error creating/finding canonical DM channel:',
        error
      );
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to process DM channel',
        variant: 'destructive',
      });
    },
  });
}

/**
 * Hook to fetch all DM conversations (channels marked as DMs) for a specific agent.
 */
export function useDmChannelsForAgent(
  agentId: UUID | undefined,
  serverId: UUID = '00000000-0000-0000-0000-000000000000' as UUID
) {
  const currentUserId = getEntityId();

  return useQuery<MessageChannel[]>({
    queryKey: ['dmChannels', agentId, currentUserId], // This key will be invalidated by useCreateDmChannel
    queryFn: async () => {
      if (!agentId) return [];
      clientLogger.info(
        '[useDmChannelsForAgent] Fetching distinct DM channels for agent:',
        agentId
      );

      const elizaClient = createElizaClient();
      const result = await elizaClient.messaging.getServerChannels(serverId);
      const allChannels = result.channels || [];

      const dmChannels = allChannels.filter((channel) => {
        const metadata = channel.metadata || {};
        const isCorrectType = channel.type === ChannelType.DM;
        const isMarkedAsDm = metadata.isDm === true;
        // Ensure this DM context is specifically associated with the target agentId
        const isForThisAgentContext = metadata.forAgent === agentId;

        const isParticipant =
          (metadata.user1 === currentUserId && metadata.user2 === agentId) ||
          (metadata.user1 === agentId && metadata.user2 === currentUserId);

        // Primary filter for new-style distinct DMs
        if (isCorrectType && isMarkedAsDm && isForThisAgentContext && isParticipant) {
          return true;
        }

        // Fallback for older, canonical DM channels that might be named DM-UserA-UserB
        // This ensures existing single DMs are still listed if they haven't been migrated to new metadata.
        // This part of the filter might become less relevant as new distinct DMs are created.
        if (channel.type === ChannelType.DM && !metadata.isDm && !metadata.forAgent) {
          const channelName = channel.name.toLowerCase();
          // Check if name follows the old convention: DM-currentUserId-agentId or DM-agentId-currentUserId
          const defaultDmName1 = `dm-${currentUserId}-${agentId}`.toLowerCase();
          const defaultDmName2 = `dm-${agentId}-${currentUserId}`.toLowerCase();
          if (channelName === defaultDmName1 || channelName === defaultDmName2) {
            clientLogger.warn(
              '[useDmChannelsForAgent] Matched a canonical DM channel by name convention:',
              channel.id,
              channel.name
            );
            return true;
          }
        }

        return false;
      });

      clientLogger.info(
        '[useDmChannelsForAgent] Found distinct DM channels:',
        dmChannels.length,
        dmChannels.map((c) => ({ id: c.id, name: c.name, metadata: c.metadata }))
      );

      return dmChannels.sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt).getTime();
        return bTime - aTime;
      });
    },
    enabled: !!agentId,
    staleTime: STALE_TIMES.FREQUENT, // More frequent stale time to catch new chats quickly
    refetchInterval: STALE_TIMES.STANDARD, // Poll less aggressively, rely on invalidation primarily
  });
}

/**
 * Hook to create a new, distinct DM channel (conversation) with an agent.
 */
export function useCreateDmChannel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const currentUserId = getEntityId();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: async ({ agentId, channelName }: { agentId: UUID; channelName: string }) => {
      clientLogger.info('[useCreateDmChannel] Creating new distinct DM channel with agent:', {
        agentId,
        channelName,
      });

      if (!channelName || !channelName.trim()) {
        // This should ideally be caught before calling the mutation, but good to have a check.
        throw new Error('Channel name cannot be empty for a new DM conversation.');
      }

      const elizaClient = createElizaClient();
      const result = await elizaClient.messaging.createGroupChannel({
        name: channelName.trim(),
        participantCentralUserIds: [currentUserId, agentId],
        type: ChannelType.DM, // Set type to DM
        server_id: '00000000-0000-0000-0000-000000000000' as UUID, // Use the default server
        metadata: {
          isDm: true, // Mark it as a DM type conversation
          user1: currentUserId, // Explicitly store participants for filtering
          user2: agentId,
          forAgent: agentId, // Critical: associates this DM context with the specific agent
          createdAt: new Date().toISOString(), // Add a creation timestamp in metadata
        },
      });

      return result; // Direct result from ElizaClient
    },
    onSuccess: (data, variables) => {
      clientLogger.info('[useCreateDmChannel] Distinct DM channel created successfully:', data);
      toast({
        title: 'New Chat Started',
        description: `Conversation "${data.name}" created.`,
      });
      // Invalidate queries to refresh the DM channel list for this agent
      queryClient.invalidateQueries({ queryKey: ['dmChannels', variables.agentId, currentUserId] });
      // Also invalidate general channels list if it might show DMs (though less likely)
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (error) => {
      clientLogger.error('[useCreateDmChannel] Error creating distinct DM channel:', error);
      toast({
        title: 'Error Creating Chat',
        description: error instanceof Error ? error.message : 'Could not start new chat.',
        variant: 'destructive',
      });
    },
  });
}
