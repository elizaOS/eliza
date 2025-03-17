import Room from '@/components/room';
import { UUID } from 'crypto';
import { useParams } from 'react-router';

export default function AgentRoute() {
  const { roomId } = useParams<{ roomId: UUID }>();

  if (!roomId) return <div>No data.</div>;
  // Go directly to the chat with the agent, skipping the room selection
  return <Room roomId={roomId} />;
}
