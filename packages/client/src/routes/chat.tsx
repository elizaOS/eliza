import { useAgent } from '@/hooks/use-query-hooks';
import { WorldManager } from '@/lib/world-manager';
import { useState } from 'react';
import { useParams } from 'react-router';

import Chat from '@/components/chat';
import { AgentSidebar } from '../components/agent-sidebar';
import type { UUID, Agent } from '@elizaos/core';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../components/ui/resizable';

export default function AgentRoute() {
  const [showDetails, setShowDetails] = useState(false);
  const worldId = WorldManager.getWorldId();

  const { agentId } = useParams<{ agentId: UUID }>();

  const { data: agentData } = useAgent(agentId);

  const agent = agentData?.data as Agent;

  const toggleDetails = () => setShowDetails(!showDetails);

  console.log(agent);

  if (!agentId) return <div>No data.</div>;

  return (
    <ResizablePanelGroup direction="horizontal" className="w-full h-full">
      <ResizablePanel defaultSize={75}>
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
        <ResizablePanel
          defaultSize={25}
          className="border rounded-lg m-4 overflow-y-scroll bg-background flex flex-col h-[96vh]"
        >
          <AgentSidebar agentId={agentId} agentName={agent.name} />
        </ResizablePanel>
      )}
    </ResizablePanelGroup>
  );
}
