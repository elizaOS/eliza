import Room from '@/components/room';
import type { UUID } from '@elizaos/core';
import { useParams } from 'react-router';

export default function AgentRoute() {
  const { serverId } = useParams<{ serverId: UUID }>();

  if (!serverId) return <div>No data.</div>;

  return <Room serverId={serverId} />;
}
