import Chat from '@/components/chat';
import type { UUID } from '@elizaos/core';
import { useParams } from 'react-router';

export default function AgentRoute() {
  const { agentId } = useParams<{ agentId: UUID }>();

  if (!agentId) return <div>No data.</div>;

  // Go directly to the chat with the agent, skipping the room selection
  return <Chat agentId={agentId} />;
}
