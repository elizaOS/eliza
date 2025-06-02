import { useAgent } from '@/hooks/use-query-hooks';
import { useState, useEffect } from 'react';
import { useParams } from 'react-router';
import { type UUID, type Agent, AgentStatus as CoreAgentStatusEnum } from '@elizaos/core';
import type { AgentWithStatus } from '../types';
import { Button } from '@/components/ui/button';
import { Play, Loader2 } from 'lucide-react';
import { useAgentManagement } from '@/hooks/use-agent-management';
import clientLogger from '@/lib/logger';

// Import the new UnifiedChatView
import UnifiedChatView from '@/components/UnifiedChatView';

/**
 * Displays the agent chat interface with an optional details sidebar in a resizable layout.
 *
 * Renders the chat panel for a specific agent, and conditionally shows a sidebar with agent details based on user interaction. If no agent ID is present in the URL, displays a "No data." message.
 */
export default function AgentRoute() {
  const { agentId } = useParams<{ agentId: UUID }>();

  useEffect(() => {
    clientLogger.info('[AgentRoute] Component mounted/updated', { agentId });
    return () => {
      clientLogger.info('[AgentRoute] Component unmounted', { agentId });
    };
  }, [agentId]);

  const { data: agentDataResponse, isLoading: isLoadingAgent } = useAgent(agentId);
  const { startAgent, isAgentStarting } = useAgentManagement();

  clientLogger.debug('[AgentRoute] Current agentId from useParams:', agentId);
  clientLogger.debug('[AgentRoute] isLoadingAgent:', isLoadingAgent);
  clientLogger.debug('[AgentRoute] agentDataResponse:', agentDataResponse);

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

  clientLogger.debug('[AgentRoute] Constructed agentFromHook:', agentFromHook);

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
        <Button onClick={handleStartAgent} disabled={isStarting} size="lg">
          {isStarting ? (
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          ) : (
            <Play className="mr-2 h-5 w-5" />
          )}
          {isStarting ? 'Starting Agent...' : 'Start Agent'}
        </Button>
      </div>
    );
  }

  clientLogger.info('[AgentRoute] Agent is active, rendering UnifiedChatView for DM', {
    agentName: agentFromHook?.name,
  });
  // AgentRoute no longer needs to manage its own ResizablePanelGroup for the chat and sidebar
  // UnifiedChatView will handle its own layout including the sidebar.
  return <UnifiedChatView chatType="DM" contextId={agentId} />;
}
