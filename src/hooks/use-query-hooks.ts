import { useQuery, useMutation, useQueryClient } from 'react-query';
import type { UUID } from "@elizaos/core";

/**
 * Fetches memories for a specific agent, optionally filtered by room
 */
export function useAgentMemories(agentId: UUID, roomId?: UUID) {
  const queryKey = roomId 
    ? ['agents', agentId, 'rooms', roomId, 'memories'] 
    : ['agents', agentId, 'memories'];
  
  return useQuery({
    queryKey,
    queryFn: async () => {
      const url = roomId 
        ? `/api/agents/${agentId}/rooms/${roomId}/memories` 
        : `/api/agents/${agentId}/memories`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch agent memories');
      }
      
      const result = await response.json();
      return result.data || [];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 10 * 1000, // Poll every 10 seconds
  });
}

/**
 * Deletes a specific memory entry for an agent
 */
export function useDeleteMemory() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ agentId, memoryId }: { agentId: UUID; memoryId: string }) => {
      const response = await fetch(`/api/agents/${agentId}/memories/${memoryId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error('Failed to delete memory');
      }
      
      return { agentId, memoryId };
    },
    onSuccess: (data) => {
      // Invalidate relevant queries to trigger refetch
      queryClient.invalidateQueries({ 
        queryKey: ['agents', data.agentId, 'memories'] 
      });
      
      // Also invalidate room-specific memories
      queryClient.invalidateQueries({
        queryKey: ['agents', data.agentId, 'rooms'],
        predicate: (query) => query.queryKey.length > 3 && query.queryKey[4] === 'memories'
      });
    },
  });
} 