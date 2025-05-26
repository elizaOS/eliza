import { useAgent } from '@/hooks/use-query-hooks';
import { WorldManager } from '@/lib/world-manager';
import { useState } from 'react';
import { useParams } from 'react-router';

import Chat from '@/components/chat';
import { AgentSidebar } from '../components/agent-sidebar';
import { type UUID, type Agent, AgentStatus as CoreAgentStatusEnum } from '@elizaos/core';
import type { AgentWithStatus } from '@/lib/api';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../components/ui/resizable';

/**
 * Displays the agent chat interface with an optional details sidebar in a resizable layout.
 *
 * Renders the chat panel for a specific agent, and conditionally shows a sidebar with agent details based on user interaction. If no agent ID is present in the URL, displays a "No data." message.
 */
export default function AgentRoute() {
  const [showDetails, setShowDetails] = useState(true);
  const worldId = WorldManager.getWorldId();

  const { agentId } = useParams<{ agentId: UUID }>();

  const { data: agentDataResponse } = useAgent(agentId);

  const agent: Agent | undefined = agentDataResponse?.data
    ? {
        ...(agentDataResponse.data as AgentWithStatus),
        status:
          agentDataResponse.data.status === 'active'
            ? CoreAgentStatusEnum.ACTIVE
            : agentDataResponse.data.status === 'inactive'
              ? CoreAgentStatusEnum.INACTIVE
              : undefined,
      }
    : undefined;

  const toggleDetails = () => setShowDetails(!showDetails);

  if (!agentId) return <div>No data.</div>;
  if (!agent) return <div>Loading agent data...</div>;

  return (
    <ResizablePanelGroup direction="horizontal" className="w-full h-full">
      <ResizablePanel defaultSize={65}>
        <Chat
          agentId={agentId}
          worldId={worldId}
          agentData={agent}
          showDetails={showDetails}
          toggleDetails={toggleDetails}
        />
      </ResizablePanel>
      <ResizableHandle />
      {showDetails && (
        <ResizablePanel defaultSize={35} className="bg-background flex flex-col h-full">
          <AgentSidebar agentId={agentId} agentName={agent?.name || ''} />
        </ResizablePanel>
      )}
    </ResizablePanelGroup>
  );
}
