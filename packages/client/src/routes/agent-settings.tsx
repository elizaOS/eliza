import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import AgentSettings from '@/components/agent-settings';
import { useAgent } from '@/hooks/use-query-hooks';
import { ArrowLeft } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import type { UUID, Agent } from '@elizaos/core';

export default function AgentSettingsRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const { data: agentData, isLoading } = useAgent(agentId as UUID);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!agentData?.data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-muted-foreground">Agent not found</p>
        <Button onClick={() => navigate('/')}>Back to Home</Button>
      </div>
    );
  }

  const agent: Agent = {
    ...agentData.data,
    createdAt: agentData.data.createdAt ?? Date.now(),
    bio: agentData.data.bio ?? [],
    topics: agentData.data.topics ?? [],
    adjectives: agentData.data.adjectives ?? [],
    style: agentData.data.style ?? { all: [], chat: [], post: [] },
    settings: agentData.data.settings ?? { secrets: {} },
  } as Agent;

  return (
    <div className="flex w-full justify-center px-4 sm:px-6 overflow-y-auto">
      <div className="w-full md:max-w-4xl py-6">
        <AgentSettings agent={agent} agentId={agentId as UUID} onSaveComplete={() => {}} />
      </div>
    </div>
  );
}
