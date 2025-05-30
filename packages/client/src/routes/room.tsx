import RoomComponent from '@/components/room';
import type { UUID } from '@elizaos/core';
import { useParams, useSearchParams } from 'react-router-dom';
import { validateUuid } from '@elizaos/core';

export default function RoomRoute() {
  const { channelId: channelIdFromPath } = useParams<{ channelId: string }>();
  const [searchParams] = useSearchParams();
  const serverIdFromQuery = searchParams.get('serverId');

  const channelId = validateUuid(channelIdFromPath);
  const serverId = validateUuid(serverIdFromQuery || '');

  if (!channelId || !serverId) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Missing channel or server information.</p>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-center">
      <div className="w-full md:max-w-4xl">
        <RoomComponent channelId={channelId} serverId={serverId} />
      </div>
    </div>
  );
}
