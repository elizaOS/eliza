import { useQuery, useMutation, useQueryClient, type UseQueryOptions, type UseMutationOptions } from '@tanstack/react-query';
import type { UUID } from '@elizaos/core';
import type { MessageServer, MessageChannel, ChannelParticipant } from '@elizaos/api-client';
import { useElizaClient } from '../provider/ElizaReactProvider';
import { useNetworkStatus } from '../internal/useNetworkStatus';
import { STALE_TIMES } from '../internal/constants';

/**
 * Hook for fetching all servers.
 * 
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing list of servers
 */
export function useServers(options: Partial<UseQueryOptions<MessageServer[], Error>> = {}) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<MessageServer[], Error>({
        queryKey: ['servers'],
        queryFn: async () => {
            const result = await client.messaging.listServers();
            return result.servers;
        },
        staleTime: STALE_TIMES.RARE,
        refetchInterval: !network.isOffline ? STALE_TIMES.RARE : false,
        ...options,
    });
}

/**
 * Hook for fetching channels for a specific server.
 * 
 * @param serverId - The UUID of the server
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing list of channels
 */
export function useChannels(
    serverId: UUID | undefined,
    options: Partial<UseQueryOptions<MessageChannel[], Error>> = {}
) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<MessageChannel[], Error>({
        queryKey: ['channels', serverId],
        queryFn: async () => {
            if (!serverId) return [];
            const result = await client.messaging.getServerChannels(serverId);
            return result.channels;
        },
        enabled: Boolean(serverId),
        staleTime: STALE_TIMES.STANDARD,
        refetchInterval: !network.isOffline && Boolean(serverId) ? STALE_TIMES.STANDARD : false,
        ...options,
    });
}

/**
 * Hook for fetching details of a specific channel.
 * 
 * @param channelId - The UUID of the channel
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing channel details
 */
export function useChannelDetails(
    channelId: UUID | undefined,
    options: Partial<UseQueryOptions<MessageChannel | null, Error>> = {}
) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<MessageChannel | null, Error>({
        queryKey: ['channelDetails', channelId],
        queryFn: async () => {
            if (!channelId) return null;
            return await client.messaging.getChannelDetails(channelId);
        },
        enabled: Boolean(channelId),
        staleTime: STALE_TIMES.STANDARD,
        refetchInterval: !network.isOffline && Boolean(channelId) ? STALE_TIMES.RARE : false,
        ...options,
    });
}

/**
 * Hook for fetching participants of a specific channel.
 * 
 * @param channelId - The UUID of the channel
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing list of participant UUIDs
 */
export function useChannelParticipants(
    channelId: UUID | undefined,
    options: Partial<UseQueryOptions<UUID[], Error>> = {}
) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<UUID[], Error>({
        queryKey: ['channelParticipants', channelId],
        queryFn: async () => {
            if (!channelId) return [];
            try {
                const result = await client.messaging.getChannelParticipants(channelId);

                let participants: UUID[] = [];
                if (result && Array.isArray(result.participants)) {
                    participants = result.participants.map((participant: ChannelParticipant) => participant.userId);
                } else if (result && Array.isArray(result)) {
                    participants = result.map(
                        (participant: ChannelParticipant | UUID | { userId?: UUID; id?: UUID }) => {
                            if (typeof participant === 'string') return participant;
                            if ('userId' in participant && participant.userId) return participant.userId;
                            if ('id' in participant && participant.id) return participant.id;
                            return participant as UUID;
                        }
                    );
                }
                return participants;
            } catch (error) {
                console.error('[useChannelParticipants] Error:', error);
                return [];
            }
        },
        enabled: Boolean(channelId),
        staleTime: STALE_TIMES.STANDARD,
        refetchInterval: !network.isOffline && Boolean(channelId) ? STALE_TIMES.FREQUENT : false,
        ...options,
    });
}

/**
 * Hook to delete a channel.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteChannel(
    options: Partial<UseMutationOptions<void, Error, { channelId: UUID; serverId: UUID }, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, { channelId: UUID; serverId: UUID }, unknown>({
        ...options,
        mutationFn: async ({ channelId }) => {
            await client.messaging.deleteChannel(channelId);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({ queryKey: ['channels', variables.serverId] });
            queryClient.invalidateQueries({ queryKey: ['channels'] });
            (onSuccess as any)?.(data, variables, context);
        },
        ...options,
    });
}

