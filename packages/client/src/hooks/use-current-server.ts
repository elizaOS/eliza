import { useQuery } from '@tanstack/react-query';
import { getElizaClient } from '@/lib/api-client-config';
import type { UUID } from '@elizaos/core';
import clientLogger from '@/lib/logger';
import { STALE_TIMES } from './use-query-hooks';

/**
 * Hook to fetch the current server's ID from the backend
 * This is the serverId that should be used when creating channels and messages
 */
export function useCurrentMessageServer() {
  return useQuery<UUID>({
    queryKey: ['currentMessageServer'],
    queryFn: async () => {
      clientLogger.info(
        '[useCurrentMessageServer] Fetching current message server ID from backend'
      );
      const elizaClient = getElizaClient();
      const result = await elizaClient.messaging.getCurrentMessageServer();
      clientLogger.info('[useCurrentServer] Current server ID:', result.messageServerId);
      return result.messageServerId;
    },
    staleTime: STALE_TIMES.RARE, // Server ID rarely changes (only on restart)
    refetchOnWindowFocus: true, // Refetch when user returns to tab (catches server restarts)
    retry: 3, // Retry on failure
  });
}
