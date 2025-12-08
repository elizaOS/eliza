import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getElizaClient } from '@/lib/api-client-config';
import { useToast } from '@/hooks/use-toast';
import type { UUID } from '@elizaos/core';

export function useAddAgentToMessageServer() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ messageServerId, agentId }: { messageServerId: UUID; agentId: UUID }) => {
      const elizaClient = getElizaClient();
      return await elizaClient.agents.addAgentToMessageServer(messageServerId, agentId);
    },
    onSuccess: (_data, variables) => {
      // Invalidate server agents query
      queryClient.invalidateQueries({
        queryKey: ['messageServerAgents', variables.messageServerId],
      });
      queryClient.invalidateQueries({ queryKey: ['agentMessageServers', variables.agentId] });

      toast({
        title: 'Agent Added',
        description: 'Agent has been successfully added to the message server',
      });
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to add agent to message server',
        variant: 'destructive',
      });
    },
  });
}

export function useRemoveAgentFromMessageServer() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ messageServerId, agentId }: { messageServerId: UUID; agentId: UUID }) => {
      const elizaClient = getElizaClient();
      return await elizaClient.agents.removeAgentFromMessageServer(messageServerId, agentId);
    },
    onSuccess: (_data, variables) => {
      // Invalidate server agents query
      queryClient.invalidateQueries({
        queryKey: ['messageServerAgents', variables.messageServerId],
      });
      queryClient.invalidateQueries({ queryKey: ['agentMessageServers', variables.agentId] });

      toast({
        title: 'Agent Removed',
        description: 'Agent has been successfully removed from the message server',
      });
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to remove agent from message server',
        variant: 'destructive',
      });
    },
  });
}
