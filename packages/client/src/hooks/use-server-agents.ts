import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createHybridClient } from '@/lib/migration-utils';
import { useToast } from '@/hooks/use-toast';
import type { UUID } from '@elizaos/core';

export function useAddAgentToServer() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ serverId, agentId }: { serverId: UUID; agentId: UUID }) =>
      createHybridClient().addAgentToServer(serverId, agentId),
    onSuccess: (_data, variables) => {
      // Invalidate server agents query
      queryClient.invalidateQueries({ queryKey: ['serverAgents', variables.serverId] });
      queryClient.invalidateQueries({ queryKey: ['agentServers', variables.agentId] });

      toast({
        title: 'Agent Added',
        description: 'Agent has been successfully added to the server',
      });
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add agent to server',
        variant: 'destructive',
      });
    },
  });
}

export function useRemoveAgentFromServer() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ serverId, agentId }: { serverId: UUID; agentId: UUID }) =>
      createHybridClient().removeAgentFromServer(serverId, agentId),
    onSuccess: (_data, variables) => {
      // Invalidate server agents query
      queryClient.invalidateQueries({ queryKey: ['serverAgents', variables.serverId] });
      queryClient.invalidateQueries({ queryKey: ['agentServers', variables.agentId] });

      toast({
        title: 'Agent Removed',
        description: 'Agent has been successfully removed from the server',
      });
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to remove agent from server',
        variant: 'destructive',
      });
    },
  });
}
