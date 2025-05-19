import Room from '@/components/room';
import type { UUID } from '@elizaos/core';
import { useParams } from 'react-router';

export default function AgentRoute() {
  const { serverId } = useParams<{ serverId: UUID }>();

  if (!serverId) return <div>No data.</div>;

  return (
    <div className="flex w-full justify-center">
      <div className="w-full md:max-w-4xl">
        <Room serverId={serverId} />
      </div>
    </div>
  );
}
