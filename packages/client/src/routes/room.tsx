import Room from '@/components/room';
import { useRooms } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import type { Agent } from '@elizaos/core';
import { useParams } from 'react-router';
import { RoomSidebar } from '../components/room-sidebar';
import { useAgents } from '../hooks/use-query-hooks';

export default function AgentRoute() {
  const { serverId } = useParams<{ serverId: UUID }>();

  const { data: agentsData } = useAgents();

  const { data: roomsData } = useRooms();

  // TODO:

  const onlineRoomAgents: Agent[] = [];
  const offlineRoomAgents: Agent[] = [];

  if (!serverId) return <div>No data.</div>;

  return (
    <>
      <Room serverId={serverId} />
      <RoomSidebar
        onlineAgents={onlineRoomAgents}
        offlineAgents={offlineRoomAgents}
        isLoading={!agentsData || !roomsData}
      />
    </>
  );
}
