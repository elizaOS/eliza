import Chat from '@/components/chat';
import type { UUID } from '@elizaos/core';
import { useParams, Navigate } from 'react-router-dom';

export default function AgentRoute() {
  const { agentId, roomId } = useParams<{ agentId: UUID; roomId?: UUID }>();

  // Provide a clear error message if agent ID is missing
  if (!agentId) {
    return <Navigate to="/agents" replace />;
  }

  console.log(`[ChatRoute] Rendering chat with agent ${agentId} and room ${roomId || 'default'}`);

  // The Chat component will handle the roomId parameter directly from useParams
  return <Chat />;
}
