import AgentSettings from '@/components/agent-settings';
import { STALE_TIMES } from '@/hooks/use-query-hooks';
import { apiClient } from '@/lib/api';
import type { UUID } from '@elizaos/core';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

export default function AgentRoute() {
  const { agentId } = useParams<{ agentId: UUID }>();

  const query = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => apiClient.getAgent(agentId ?? ''),
    // Use polling for real-time updates
    staleTime: STALE_TIMES.FREQUENT,
    refetchInterval: 5000, // Poll every 5 seconds
    enabled: Boolean(agentId),
  });

  if (!agentId) return <div>No data.</div>;

  const agent = query?.data?.data;

  if (!agent) return null;

  return (
    <div className="flex w-full justify-center">
      <div className="w-full md:max-w-4xl">
        <AgentSettings agent={agent} agentId={agentId} />
      </div>
    </div>
  );
}
