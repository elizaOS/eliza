import { useQuery } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import type { UUID } from '@elizaos/core';
import clientLogger from '@/lib/logger';
import { STALE_TIMES } from './use-query-hooks';

/**
 * Hook to fetch the current server's ID from the backend
 * This is the serverId that should be used when creating channels and messages
 */
export function useCurrentServer() {
  return useQuery<UUID>({
    queryKey: ['currentServer'],
    queryFn: async () => {
      clientLogger.info('[useCurrentServer] Fetching current server ID from backend');
      const elizaClient = createElizaClient();
      const result = await elizaClient.messaging.getCurrentServer();
      clientLogger.info('[useCurrentServer] Current server ID:', result.serverId);
      return result.serverId;
    },
    staleTime: STALE_TIMES.RARE, // Server ID rarely changes (only on restart)
    refetchOnWindowFocus: true, // Refetch when user returns to tab (catches server restarts)
    retry: 3, // Retry on failure
  });
}