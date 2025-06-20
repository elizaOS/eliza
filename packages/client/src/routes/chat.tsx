import ChatComponent from '@/components/chat';
import { Button } from '@/components/ui/button';
import { useAgentManagement } from '@/hooks/use-agent-management';
import { useAgent } from '@/hooks/use-query-hooks';
import clientLogger from '@/lib/logger';
import {
  type Agent,
  ChannelType,
  AgentStatus as CoreAgentStatusEnum,
  type UUID,
} from '@elizaos/core';
import { Loader2, Play, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import type { AgentWithStatus } from '../types';

/**
 * Displays the agent chat interface with an optional details sidebar in a resizable layout.
 *
 * Renders the chat panel for a specific agent, and conditionally shows a sidebar with agent details based on user interaction. If no agent ID is present in the URL, displays a "No data." message.
 */
export default function AgentRoute() {
  // useParams will include agentId and optionally channelId for /chat/:agentId/:channelId routes
  const { agentId, channelId } = useParams<{ agentId: UUID; channelId?: UUID }>();
  const navigate = useNavigate();

  useEffect(() => {
    clientLogger.info('[AgentRoute] Component mounted/updated', { agentId, channelId });
    return () => {
      clientLogger.info('[AgentRoute] Component unmounted', { agentId, channelId });
    };
  }, [agentId, channelId]);

  const { data: agentDataResponse, isLoading: isLoadingAgent } = useAgent(agentId);
  const { startAgent, isAgentStarting } = useAgentManagement();

  const agentFromHook: Agent | undefined = agentDataResponse?.data
    ? ({
        ...(agentDataResponse.data as AgentWithStatus),
        status:
          agentDataResponse.data.status === 'active'
            ? CoreAgentStatusEnum.ACTIVE
            : agentDataResponse.data.status === 'inactive'
              ? CoreAgentStatusEnum.INACTIVE
              : CoreAgentStatusEnum.INACTIVE,
        username: agentDataResponse.data.username || agentDataResponse.data.name || 'Unknown',
        bio: agentDataResponse.data.bio || '',
        messageExamples: agentDataResponse.data.messageExamples || [],
        postExamples: agentDataResponse.data.postExamples || [],
        topics: agentDataResponse.data.topics || [],
        adjectives: agentDataResponse.data.adjectives || [],
        knowledge: agentDataResponse.data.knowledge || [],
        plugins: agentDataResponse.data.plugins || [],
        settings: agentDataResponse.data.settings || {},
        secrets: (agentDataResponse.data as any).secrets || {},
        style: agentDataResponse.data.style || {},
        templates: agentDataResponse.data.templates || {},
        enabled:
          typeof agentDataResponse.data.enabled === 'boolean'
            ? agentDataResponse.data.enabled
            : true,
        createdAt:
          typeof agentDataResponse.data.createdAt === 'number'
            ? agentDataResponse.data.createdAt
            : Date.now(),
        updatedAt:
          typeof agentDataResponse.data.updatedAt === 'number'
            ? agentDataResponse.data.updatedAt
            : Date.now(),
      } as Agent)
    : undefined;

  if (!agentId) return <div className="p-4">Agent ID not provided.</div>;
  if (isLoadingAgent || !agentFromHook)
    return (
      <div className="p-4 flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );

  const isActive = agentFromHook.status === CoreAgentStatusEnum.ACTIVE;
  const isStarting = isAgentStarting(agentFromHook.id);

  const handleStartAgent = () => {
    if (agentFromHook) {
      startAgent(agentFromHook);
    }
  };

  if (!isActive) {
    clientLogger.info('[AgentRoute] Agent is not active, rendering inactive state UI', {
      agentName: agentFromHook?.name,
    });
    return (
      <div className="flex flex-col items-center justify-center h-full w-full p-8 text-center">
        <h2 className="text-2xl font-semibold mb-4">{agentFromHook.name} is not active.</h2>
        <p className="text-muted-foreground mb-6">Press the button below to start this agent.</p>
        <div className="flex gap-3">
          <Button onClick={() => navigate(`/settings/${agentId}`)} variant="outline" size="lg">
            <Settings className="h-5 w-5" />
          </Button>
          <Button onClick={handleStartAgent} disabled={isStarting} size="lg">
            {isStarting ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <Play className="mr-2 h-5 w-5" />
            )}
            {isStarting ? 'Starting Agent...' : 'Start Agent'}
          </Button>
        </div>
      </div>
    );
  }

  clientLogger.info('[AgentRoute] Agent is active, rendering chat for DM', {
    agentName: agentFromHook?.name,
    dmChannelIdFromRoute: channelId,
  });

  return (
    <ChatComponent
      key={`${agentId}-${channelId || 'no-dm-channel'}`}
      chatType={ChannelType.DM}
      contextId={agentId}
      initialDmChannelId={channelId}
    />
  );
}
