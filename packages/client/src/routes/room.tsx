import Room from '@/components/room';
import { UUID } from 'crypto';
import { useParams } from 'react-router';

export default function AgentRoute() {
  const { serverId } = useParams<{ serverId: UUID }>();

  if (!serverId) return <div>No data.</div>;
  // Go directly to the chat with the agent, skipping the room selection
  return <Room serverId={serverId} />;
}
